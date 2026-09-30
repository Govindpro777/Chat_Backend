import { Server as SocketIOServer } from "socket.io";
import Message from "./model/MessagesModel.js";
import Channel from "./model/ChannelModel.js";
import User from "./model/UserModel.js";
import { sendPushToUser } from "./lib/push.js";

const setupSocket = (server, app) => {
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

  // ---- voice/video call signalling (the media itself flows peer to peer) ----
  const RING_TIMEOUT = 50000;
  const DISCONNECT_GRACE = 10000;
  const activeCalls = new Map(); // callId -> { callId, caller, callee, type, state, timer }
  const userCall = new Map(); // userId -> callId

  const emitToUser = (userId, event, payload) => {
    const socketId = userSocketMap.get(userId);
    if (socketId) io.to(socketId).emit(event, payload);
  };

  // Ends a call and tells the other side (everyone except the user who ended it)
  const endCallById = (callId, reason, exceptUserId) => {
    const call = activeCalls.get(callId);
    if (!call) return;
    clearTimeout(call.timer);
    activeCalls.delete(callId);
    userCall.delete(call.caller);
    userCall.delete(call.callee);
    [call.caller, call.callee].forEach((id) => {
      if (id !== exceptUserId) emitToUser(id, "call:ended", { callId, reason });
    });
  };

  const getCallFor = (userId, callId) => {
    const call = activeCalls.get(callId);
    if (!call) return null;
    return call.caller === userId || call.callee === userId ? call : null;
  };

  const otherParty = (call, userId) =>
    call.caller === userId ? call.callee : call.caller;

  const inviteToCall = async (userId, payload, ack) => {
    const reply = (res) => typeof ack === "function" && ack(res);
    const { to, callId, callType } = payload || {};
    if (
      !userId ||
      typeof to !== "string" ||
      typeof callId !== "string" ||
      !["audio", "video"].includes(callType) ||
      to === userId
    ) {
      return reply({ ok: false, reason: "failed" });
    }
    if (userCall.has(userId)) return reply({ ok: false, reason: "busy" });

    const caller = await User.findById(userId).select(
      "firstName lastName email image color"
    );
    if (!caller) return reply({ ok: false, reason: "failed" });

    if (!userSocketMap.has(to)) {
      // Not connected: a push notification is the best we can do
      sendPushToUser(to, {
        chatId: `call-${userId}`,
        title: `Missed ${callType} call`,
        body: senderName(caller),
        url: `/chat/contact/${userId}`,
        icon: caller.image,
      }).catch(() => {});
      return reply({ ok: false, reason: "unavailable" });
    }
    if (userCall.has(to)) return reply({ ok: false, reason: "busy" });

    const call = {
      callId,
      caller: userId,
      callee: to,
      type: callType,
      state: "ringing",
      timer: setTimeout(() => endCallById(callId, "no-answer"), RING_TIMEOUT),
    };
    activeCalls.set(callId, call);
    userCall.set(userId, callId);
    userCall.set(to, callId);

    emitToUser(to, "call:incoming", { callId, callType, from: caller });
    sendPushToUser(to, {
      chatId: `call-${userId}`,
      title: `Incoming ${callType} call`,
      body: senderName(caller),
      url: `/chat/contact/${userId}`,
      icon: caller.image,
    }).catch(() => {});
    reply({ ok: true });
  };

  const acceptCall = (userId, { callId } = {}) => {
    const call = getCallFor(userId, callId);
    if (!call || call.callee !== userId || call.state !== "ringing") return;
    call.state = "accepted";
    clearTimeout(call.timer);
    emitToUser(call.caller, "call:accepted", { callId });
  };

  const rejectCall = (userId, { callId } = {}) => {
    const call = getCallFor(userId, callId);
    if (!call || call.callee !== userId) return;
    endCallById(callId, "rejected", userId);
  };

  const relaySignal = (userId, { callId, data } = {}) => {
    const call = getCallFor(userId, callId);
    if (!call || !data || JSON.stringify(data).length > 20000) return;
    emitToUser(otherParty(call, userId), "call:signal", { callId, data });
  };

  const endCall = (userId, { callId, reason } = {}) => {
    const call = getCallFor(userId, callId);
    if (!call) return;
    endCallById(callId, typeof reason === "string" ? reason : "hangup", userId);
  };

  const relayMediaState = (userId, { callId, micOn, camOn } = {}) => {
    const call = getCallFor(userId, callId);
    if (!call) return;
    emitToUser(otherParty(call, userId), "call:media-state", {
      callId,
      micOn: !!micOn,
      camOn: !!camOn,
    });
  };

  // Lets HTTP controllers push socket events to specific users
  app?.set("notifyUsers", (userIds, event, payload) => {
    userIds.forEach((id) => {
      const socketId = userSocketMap.get(id);
      if (socketId) io.to(socketId).emit(event, payload);
    });
  });

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

  // Retried sends carry the same clientId, so they never create a second message
  const createMessageOnce = async (data) => {
    const find = () =>
      Message.findOne({ sender: data.sender, clientId: data.clientId });
    if (data.clientId) {
      const existing = await find();
      if (existing) return { doc: existing, duplicate: true };
    }
    try {
      return { doc: await Message.create(data), duplicate: false };
    } catch (err) {
      if (err.code === 11000 && data.clientId) {
        const existing = await find();
        if (existing) return { doc: existing, duplicate: true };
      }
      throw err;
    }
  };

  const sendMessage = async (userId, message, ack) => {
    const reply = (payload) => typeof ack === "function" && ack(payload);
    try {
      if (!userId || !message?.recipient) return reply({ ok: false });

      const { doc, duplicate } = await createMessageOnce({
        sender: userId,
        recipient: message.recipient,
        content: message.content,
        messageType: message.messageType,
        audioUrl: message.audioUrl,
        fileUrl: message.fileUrl,
        clientId: message.clientId,
      });

      const messageData = await Message.findById(doc._id)
        .populate("sender", "id email firstName lastName image color")
        .populate("recipient", "id email firstName lastName image color")
        .exec();

      const recipientSocketId = userSocketMap.get(String(message.recipient));
      const senderSocketId = userSocketMap.get(userId);

      // A retry only needs to confirm delivery to the sender again
      if (!duplicate && recipientSocketId) {
        io.to(recipientSocketId).emit("receiveMessage", messageData);
      }
      if (senderSocketId) {
        io.to(senderSocketId).emit("receiveMessage", messageData);
      }

      reply({ ok: true });

      if (!duplicate) {
        // Background/closed-app notification; failures must not affect delivery
        sendPushToUser(messageData.recipient._id.toString(), {
          chatId: messageData.sender._id.toString(),
          title: senderName(messageData.sender),
          body: pushBody(messageData),
          url: `/chat/contact/${messageData.sender._id}`,
          icon: messageData.sender.image,
        }).catch((err) => console.log("Push error", err.message));
      }
    } catch (error) {
      console.log("sendMessage failed", error.message);
      reply({ ok: false });
    }
  };

  const sendChannelMessage = async (userId, message, ack) => {
    const reply = (payload) => typeof ack === "function" && ack(payload);
    try {
      const { channelId, content, messageType, fileUrl, clientId } = message || {};
      if (!userId || !channelId) return reply({ ok: false });

      const channel = await Channel.findById(channelId).populate("members");
      if (!channel) return reply({ ok: false });
      const participantIds = [...channel.members, channel.admin].map((u) =>
        (u._id || u).toString()
      );
      if (!participantIds.includes(userId)) return reply({ ok: false });

      const { doc, duplicate } = await createMessageOnce({
        sender: userId,
        recipient: null, // Channel messages don't have a single recipient
        content,
        messageType,
        timestamp: new Date(),
        fileUrl,
        clientId,
      });

      const messageData = await Message.findById(doc._id)
        .populate("sender", "id email firstName lastName image color")
        .exec();
      const finalData = { ...messageData._doc, channelId: channel._id };

      if (duplicate) {
        const senderSocketId = userSocketMap.get(userId);
        if (senderSocketId) {
          io.to(senderSocketId).emit("recieve-channel-message", finalData);
        }
        return reply({ ok: true });
      }

      await Channel.findByIdAndUpdate(channelId, {
        $push: { messages: doc._id },
      });

      participantIds.forEach((id) => {
        const socketId = userSocketMap.get(id);
        if (socketId) {
          io.to(socketId).emit("recieve-channel-message", finalData);
        }
      });

      reply({ ok: true });

      const senderId = messageData.sender._id.toString();
      participantIds
        .filter((id) => id !== senderId)
        .forEach((id) => {
          sendPushToUser(id, {
            chatId: channel._id.toString(),
            title: `#${channel.name}`,
            body: `${senderName(messageData.sender)}: ${pushBody(messageData)}`,
            url: `/chat/channel/${channel._id}`,
            icon: messageData.sender.image,
          }).catch((err) => console.log("Push error", err.message));
        });
    } catch (error) {
      console.log("sendChannelMessage failed", error.message);
      reply({ ok: false });
    }
  };

  // One reaction per user; sending the same emoji again removes it
  const reactToMessage = async (userId, payload) => {
    const { messageId, emoji } = payload || {};
    if (!userId || !messageId || typeof emoji !== "string") return;
    if (!emoji || emoji.length > 8) return;

    const message = await Message.findById(messageId);
    if (!message) return;

    let participantIds;
    let channelId = null;
    if (message.recipient) {
      participantIds = [message.sender.toString(), message.recipient.toString()];
    } else {
      const channel = await Channel.findOne({ messages: message._id });
      if (!channel) return;
      participantIds = [...channel.members, channel.admin].map((u) =>
        u.toString()
      );
      channelId = channel._id.toString();
    }
    if (!participantIds.includes(userId)) return;

    const existing = message.reactions.find((r) => r.user.toString() === userId);
    if (existing && existing.emoji === emoji) {
      message.reactions = message.reactions.filter(
        (r) => r.user.toString() !== userId
      );
    } else if (existing) {
      existing.emoji = emoji;
    } else {
      message.reactions.push({ user: userId, emoji });
    }
    await message.save();

    const reactions = message.reactions.map((r) => ({
      user: r.user.toString(),
      emoji: r.emoji,
    }));
    participantIds.forEach((id) => {
      const socketId = userSocketMap.get(id);
      if (socketId) {
        io.to(socketId).emit("message-reaction", {
          messageId,
          channelId,
          reactions,
        });
      }
    });
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

        // Give a flaky connection a moment to come back before dropping the call
        const callId = userCall.get(userId);
        if (callId) {
          setTimeout(() => {
            if (!userSocketMap.has(userId) && userCall.get(userId) === callId) {
              endCallById(callId, "disconnected", userId);
            }
          }, DISCONNECT_GRACE);
        }
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

    socket.on("sendMessage", (message, ack) =>
      sendMessage(userId, message, ack)
    );

    // Relay typing state to the other person in a direct chat
    socket.on("typing", ({ to, isTyping } = {}) => {
      const recipientSocketId = userSocketMap.get(to);
      if (userId && recipientSocketId) {
        io.to(recipientSocketId).emit("typing", { from: userId, isTyping });
      }
    });

    socket.on("mark-seen", ({ chatUserId } = {}) => {
      markMessagesSeen(userId, chatUserId).catch((err) => console.log(err));
    });

    socket.on("send-channel-message", (message, ack) =>
      sendChannelMessage(userId, message, ack)
    );

    socket.on("call:invite", (payload, ack) => {
      inviteToCall(userId, payload, ack).catch((err) => {
        console.log("call invite failed", err.message);
        if (typeof ack === "function") ack({ ok: false, reason: "failed" });
      });
    });
    socket.on("call:accept", (payload) => acceptCall(userId, payload));
    socket.on("call:reject", (payload) => rejectCall(userId, payload));
    socket.on("call:signal", (payload) => relaySignal(userId, payload));
    socket.on("call:media-state", (payload) => relayMediaState(userId, payload));
    socket.on("call:end", (payload) => endCall(userId, payload));

    socket.on("react-message", (payload) => {
      reactToMessage(userId, payload).catch((err) =>
        console.log("react failed", err.message)
      );
    });

    socket.on("disconnect", () => disconnect(socket));
  });
};

export default setupSocket;
