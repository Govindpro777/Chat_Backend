import { Server as SocketIOServer } from "socket.io";
import Message from "./model/MessagesModel.js";
import Channel from "./model/ChannelModel.js";
import { sendPushToUser } from "./lib/push.js";

const setupSocket = (server) => {
  const io = new SocketIOServer(server, {
    cors: {
      origin: [
        "http://localhost:5173",
        "http://localhost:5174",
        "https://chat-frontend-red-delta.vercel.app",
        "https://www.chat-frontend-red-delta.vercel.app",
        "https://chat-backend-wly0.onrender.com",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  const userSocketMap = new Map();

  const addChannelNotify = async (channel) => {
    if (channel && channel.members) {
      channel.members.forEach((member) => {
        const memberSocketId = userSocketMap.get(member.toString());
        if (memberSocketId) {
          io.to(memberSocketId).emit("new-channel-added", channel);
        }
      });
    }
  };

  const senderName = (sender) =>
    `${sender.firstName || sender.email} ${sender.lastName || ""}`.trim();

  const pushBody = (message) =>
    message.messageType === "file" ? "Sent a file" : message.content;

  const sendMessage = async (message) => {
    const recipientSocketId = userSocketMap.get(message.recipient);
    const senderSocketId = userSocketMap.get(message.sender);

    // Create the message
    const createdMessage = await Message.create(message);

    // Find the created message by its ID and populate sender and recipient details
    const messageData = await Message.findById(createdMessage._id)
      .populate("sender", "id email firstName lastName image color")
      .populate("recipient", "id email firstName lastName image color")
      .exec();

    if (recipientSocketId) {
      io.to(recipientSocketId).emit("receiveMessage", messageData);
    }

    // Optionally, send the message back to the sender (e.g., for message confirmation)
    if (senderSocketId) {
      io.to(senderSocketId).emit("receiveMessage", messageData);
    }

    // Background/closed-app notification; failures must not affect delivery
    sendPushToUser(messageData.recipient._id.toString(), {
      chatId: messageData.sender._id.toString(),
      title: senderName(messageData.sender),
      body: pushBody(messageData),
      url: `/chat/contact/${messageData.sender._id}`,
      icon: messageData.sender.image,
    }).catch((err) => console.log("Push error", err.message));
  };

  const sendChannelMessage = async (message) => {
    const { channelId, sender, content, messageType, fileUrl } = message;

    // Create and save the message
    const createdMessage = await Message.create({
      sender,
      recipient: null, // Channel messages don't have a single recipient
      content,
      messageType,
      timestamp: new Date(),
      fileUrl,
    });

    const messageData = await Message.findById(createdMessage._id)
      .populate("sender", "id email firstName lastName image color")
      .exec();

    // Add message to the channel
    await Channel.findByIdAndUpdate(channelId, {
      $push: { messages: createdMessage._id },
    });

    // Fetch all members of the channel
    const channel = await Channel.findById(channelId).populate("members");

    const finalData = { ...messageData._doc, channelId: channel._id };
    if (channel && channel.members) {
      channel.members.forEach((member) => {
        const memberSocketId = userSocketMap.get(member._id.toString());
        if (memberSocketId) {
          io.to(memberSocketId).emit("recieve-channel-message", finalData);
        }
      });
      const adminSocketId = userSocketMap.get(channel.admin._id.toString());
      if (adminSocketId) {
        io.to(adminSocketId).emit("recieve-channel-message", finalData);
      }

      const senderId = messageData.sender._id.toString();
      const recipientIds = new Set(
        [...channel.members, channel.admin].map((u) => u._id.toString())
      );
      recipientIds.delete(senderId);
      recipientIds.forEach((id) => {
        sendPushToUser(id, {
          chatId: channel._id.toString(),
          title: `#${channel.name}`,
          body: `${senderName(messageData.sender)}: ${pushBody(messageData)}`,
          url: `/chat/channel/${channel._id}`,
          icon: messageData.sender.image,
        }).catch((err) => console.log("Push error", err.message));
      });
    }
  };

  // Viewer has opened the chat with chatUserId: mark that user's messages as seen
  const markMessagesSeen = async (viewerId, chatUserId) => {
    if (!viewerId || !chatUserId) return;
    const seenAt = new Date();
    const result = await Message.updateMany(
      { sender: chatUserId, recipient: viewerId, seen: false },
      { $set: { seen: true, seenAt } }
    );
    if (result.modifiedCount > 0) {
      const senderSocketId = userSocketMap.get(chatUserId);
      if (senderSocketId) {
        io.to(senderSocketId).emit("messages-seen", { by: viewerId, seenAt });
      }
    }
  };

  const broadcastOnlineUsers = () => {
    io.emit("online-users", Array.from(userSocketMap.keys()));
  };

  const disconnect = (socket) => {
    console.log("Client disconnected", socket.id);
    for (const [userId, socketId] of userSocketMap.entries()) {
      if (socketId === socket.id) {
        userSocketMap.delete(userId);
        break;
      }
    }
    broadcastOnlineUsers();
  };

  io.on("connection", (socket) => {
    const userId = socket.handshake.query.userId;

    if (userId) {
      userSocketMap.set(userId, socket.id);
      console.log(`User connected: ${userId} with socket ID: ${socket.id}`);
      broadcastOnlineUsers();
    } else {
      console.log("User ID not provided during connection.");
    }

    socket.on("add-channel-notify", addChannelNotify);

    socket.on("sendMessage", sendMessage);

    socket.on("mark-seen", ({ chatUserId } = {}) => {
      markMessagesSeen(userId, chatUserId).catch((err) => console.log(err));
    });

    socket.on("send-channel-message", sendChannelMessage);

    socket.on("disconnect", () => disconnect(socket));
  });
};

export default setupSocket;
