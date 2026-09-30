import mongoose from "mongoose";
import path from "path";
import { existsSync, unlinkSync, rmdirSync } from "fs";
import Message from "../model/MessagesModel.js";
import Channel from "../model/ChannelModel.js";
import User from "../model/UserModel.js";

export const createChannel = async (request, response, next) => {
  try {
    const { name, members } = request.body;
    const userId = request.userId;
    const admin = await User.findById(userId);
    if (!admin) {
      return response.status(400).json({ message: "Admin user not found." });
    }

    const validMembers = await User.find({ _id: { $in: members } });
    if (validMembers.length !== members.length) {
      return response
        .status(400)
        .json({ message: "Some members are not valid users." });
    }

    const newChannel = new Channel({
      name,
      members,
      admin: userId,
    });

    await newChannel.save();

    return response.status(201).json({ channel: newChannel });
  } catch (error) {
    console.error("Error creating channel:", error);
    return response.status(500).json({ message: "Internal Server Error" });
  }
};

export const getUserChannels = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(req.userId);
    const channels = await Channel.find({
      $or: [{ admin: userId }, { members: userId }],
    }).sort({ updatedAt: -1 });

    return res.status(200).json({ channels });
  } catch (error) {
    console.error("Error getting user channels:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

export const getChannelMessages = async (req, res, next) => {
  try {
    const { channelId } = req.params;

    const channel = await Channel.findById(channelId).populate({
      path: "messages",
      populate: {
        path: "sender",
        select: "firstName lastName email _id image color",
      },
    });

    if (!channel) {
      return res.status(404).json({ message: "Channel not found" });
    }

    const messages = channel.messages;
    return res.status(200).json({ messages });
  } catch (error) {
    console.error("Error getting channel messages:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

const FILES_ROOT = path.resolve("uploads/files");

const memberIds = (channel) => [
  ...channel.members.map((m) => m.toString()),
  channel.admin.toString(),
];

// Members (with profile details) for the channel info screen
export const getChannelDetails = async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId)
      .populate("members", "firstName lastName email image color")
      .populate("admin", "firstName lastName email image color");
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    const ids = [
      ...channel.members.map((m) => m._id.toString()),
      channel.admin._id.toString(),
    ];
    if (!ids.includes(req.userId)) {
      return res.status(403).json({ message: "Not a member of this channel" });
    }
    return res.status(200).json({
      channel: {
        _id: channel._id,
        name: channel.name,
        admin: channel.admin,
        members: channel.members,
      },
    });
  } catch (error) {
    console.error("Error getting channel details:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// Owner only: rename the channel and/or add/remove members
export const updateChannel = async (req, res) => {
  try {
    const { name, addMembers = [], removeMembers = [] } = req.body;
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    if (channel.admin.toString() !== req.userId) {
      return res.status(403).json({ message: "Only the owner can edit this channel" });
    }

    const previousIds = memberIds(channel);

    if (typeof name === "string") {
      if (!name.trim()) {
        return res.status(400).json({ message: "Channel name is required" });
      }
      channel.name = name.trim();
    }

    if (addMembers.length) {
      const valid = await User.find({ _id: { $in: addMembers } }).select("_id");
      const current = new Set(channel.members.map((m) => m.toString()));
      valid.forEach((u) => {
        if (!current.has(u._id.toString()) && u._id.toString() !== req.userId) {
          channel.members.push(u._id);
        }
      });
    }

    if (removeMembers.length) {
      const toRemove = new Set(removeMembers.map(String));
      toRemove.delete(channel.admin.toString());
      channel.members = channel.members.filter((m) => !toRemove.has(m.toString()));
    }

    await channel.save();

    const currentIds = memberIds(channel);
    const added = currentIds.filter((id) => !previousIds.includes(id));
    const removed = previousIds.filter((id) => !currentIds.includes(id));
    const notify = req.app.get("notifyUsers");

    notify?.(added, "new-channel-added", channel);
    notify?.(
      currentIds.filter((id) => !added.includes(id)),
      "channel-updated",
      channel
    );
    notify?.(removed, "channel-deleted", { channelId: channel._id.toString() });

    return res.status(200).json({ channel });
  } catch (error) {
    console.error("Error updating channel:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// Owner only: delete the channel, its messages and their attachments
export const deleteChannel = async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    if (channel.admin.toString() !== req.userId) {
      return res.status(403).json({ message: "Only the owner can delete this channel" });
    }

    const messages = await Message.find({ _id: { $in: channel.messages } });
    messages.forEach((message) => {
      if (message.messageType !== "file") return;
      const filePath = path.resolve(message.fileUrl);
      if (filePath.startsWith(FILES_ROOT + path.sep) && existsSync(filePath)) {
        unlinkSync(filePath);
        try {
          rmdirSync(path.dirname(filePath));
        } catch {
          // folder not empty
        }
      }
    });
    await Message.deleteMany({ _id: { $in: channel.messages } });

    const ids = memberIds(channel);
    await Channel.deleteOne({ _id: channel._id });

    req.app.get("notifyUsers")?.(ids, "channel-deleted", {
      channelId: channel._id.toString(),
    });

    return res.status(200).json({ channelId: channel._id });
  } catch (error) {
    console.error("Error deleting channel:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

// Any non-owner member can leave
export const leaveChannel = async (req, res) => {
  try {
    const channel = await Channel.findById(req.params.channelId);
    if (!channel) return res.status(404).json({ message: "Channel not found" });
    if (channel.admin.toString() === req.userId) {
      return res
        .status(400)
        .json({ message: "The owner can't leave. Delete the channel instead." });
    }
    channel.members = channel.members.filter((m) => m.toString() !== req.userId);
    await channel.save();

    const notify = req.app.get("notifyUsers");
    notify?.(memberIds(channel), "channel-updated", channel);
    notify?.([req.userId], "channel-deleted", {
      channelId: channel._id.toString(),
    });

    return res.status(200).json({ channelId: channel._id });
  } catch (error) {
    console.error("Error leaving channel:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};
