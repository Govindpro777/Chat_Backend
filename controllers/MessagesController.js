import Message from "../model/MessagesModel.js";
import { mkdirSync, renameSync, unlinkSync, rmdirSync, existsSync } from "fs";
import path from "path";
import Channel from "../model/ChannelModel.js";

const FILES_ROOT = path.resolve("uploads/files");

export const getMessages = async (req, res, next) => {
  try {
    const user1 = req.userId;
    const user2 = req.body.id;
    if (!user1 || !user2) {
      return res.status(400).send("Both user IDs are required.");
    }

    const messages = await Message.find({
      $or: [
        { sender: user1, recipient: user2 },
        { sender: user2, recipient: user1 },
      ],
    }).sort({ timestamp: 1 });

    return res.status(200).json({ messages });
  } catch (err) {
    console.log(err);
    return res.status(500).send("Internal Server Error");
  }
};

export const uploadFile = async (request, response, next) => {
  try {
    if (request.file) {
      console.log("in try if");
      const date = Date.now();
      let fileDir = `uploads/files/${date}`;
      let fileName = `${fileDir}/${request.file.originalname}`;

      // Create directory if it doesn't exist
      mkdirSync(fileDir, { recursive: true });

      renameSync(request.file.path, fileName);
      return response.status(200).json({ filePath: fileName });
    } else {
      return response.status(404).send("File is required.");
    }
  } catch (error) {
    console.log({ error });
    return response.status(500).send("Internal Server Error.");
  }
};

// Deletes an attachment message and its file from the server (sender only)
export const deleteFileMessage = async (req, res, next) => {
  try {
    const message = await Message.findById(req.params.messageId);
    if (!message) return res.status(404).send("Message not found.");
    if (message.messageType !== "file") {
      return res.status(400).send("Only attachments can be deleted.");
    }
    if (message.sender.toString() !== req.userId) {
      return res.status(403).send("You can only delete your own attachments.");
    }

    // Resolve inside the uploads folder so a stored path can never escape it
    const filePath = path.resolve(message.fileUrl);
    if (filePath.startsWith(FILES_ROOT + path.sep) && existsSync(filePath)) {
      unlinkSync(filePath);
      try {
        rmdirSync(path.dirname(filePath)); // remove the timestamp folder if empty
      } catch {
        // folder not empty, leave it
      }
    }

    // Work out who needs to know before the message is removed
    const recipients = new Set([message.sender.toString()]);
    let channelId = null;
    if (message.recipient) {
      recipients.add(message.recipient.toString());
    } else {
      const channel = await Channel.findOne({ messages: message._id });
      if (channel) {
        channelId = channel._id.toString();
        channel.members.forEach((m) => recipients.add(m.toString()));
        recipients.add(channel.admin.toString());
        await Channel.updateOne(
          { _id: channel._id },
          { $pull: { messages: message._id } }
        );
      }
    }

    await Message.deleteOne({ _id: message._id });

    req.app.get("notifyUsers")?.([...recipients], "message-deleted", {
      messageId: message._id.toString(),
      channelId,
    });

    return res.status(200).json({ messageId: message._id });
  } catch (error) {
    console.log({ error });
    return res.status(500).send("Internal Server Error.");
  }
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Search the text messages the user can see: their direct chats and their channels
export const searchMessages = async (req, res, next) => {
  try {
    const query = String(req.body.query || "").trim();
    if (query.length < 2) return res.status(200).json({ results: [] });

    const userId = req.userId;
    const regex = new RegExp(escapeRegex(query), "i");
    const fields = "firstName lastName email image color";

    const channels = await Channel.find({
      $or: [{ admin: userId }, { members: userId }],
    }).select("name messages");
    const channelByMessage = new Map();
    channels.forEach((channel) =>
      channel.messages.forEach((id) => channelByMessage.set(id.toString(), channel))
    );

    const messages = await Message.find({
      messageType: "text",
      content: regex,
      $or: [
        { sender: userId },
        { recipient: userId },
        { _id: { $in: [...channelByMessage.keys()] } },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(40)
      .populate("sender", fields)
      .populate("recipient", fields);

    const results = messages
      .map((message) => {
        const channel = channelByMessage.get(message._id.toString());
        if (channel) {
          return {
            _id: message._id,
            content: message.content,
            timestamp: message.timestamp,
            type: "channel",
            chat: { _id: channel._id, name: channel.name },
            sender: message.sender,
          };
        }
        if (!message.recipient) return null;
        const other =
          message.sender._id.toString() === userId
            ? message.recipient
            : message.sender;
        return {
          _id: message._id,
          content: message.content,
          timestamp: message.timestamp,
          type: "contact",
          chat: other,
          sender: message.sender,
        };
      })
      .filter(Boolean);

    return res.status(200).json({ results });
  } catch (error) {
    console.log({ error });
    return res.status(500).send("Internal Server Error");
  }
};
