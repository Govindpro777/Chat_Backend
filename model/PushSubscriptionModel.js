import mongoose from "mongoose";

const pushSubscriptionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "Users", required: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  settings: {
    enabled: { type: Boolean, default: true },
    preview: { type: Boolean, default: true },
    mutedChats: { type: [String], default: [] },
  },
  createdAt: { type: Date, default: Date.now },
});

pushSubscriptionSchema.index({ user: 1 });

const PushSubscription = mongoose.model(
  "PushSubscriptions",
  pushSubscriptionSchema
);
export default PushSubscription;
