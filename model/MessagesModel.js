import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Users",
    required: true,
  },
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Users",
    required: false,
  },
  messageType: {
    type: String,
    enum: ["text", "audio", "file"],
    required: true,
  },
  content: {
    type: String,
    required: function () {
      return this.messageType === "text";
    },
  },
  audioUrl: {
    type: String,
    required: function () {
      return this.messageType === "audio";
    },
  },
  fileUrl: {
    type: String,
    required: function () {
      return this.messageType === "file";
    },
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  clientId: {
    type: String,
  },
  reactions: {
    type: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
        emoji: { type: String, required: true },
        _id: false,
      },
    ],
    default: [],
  },
  seen: {
    type: Boolean,
    default: false,
  },
  seenAt: {
    type: Date,
    default: null,
  },
});

// Makes retried sends idempotent: one message per (sender, clientId)
messageSchema.index(
  { sender: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: "string" } } }
);
messageSchema.index({ sender: 1, recipient: 1, timestamp: -1 });

const Message = mongoose.model("Messages", messageSchema);
export default Message;
