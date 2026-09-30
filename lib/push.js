import webpush from "web-push";
import PushSubscription from "../model/PushSubscriptionModel.js";

let configured = false;

export const isPushConfigured = () => {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    VAPID_SUBJECT || "mailto:admin@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  configured = true;
  return true;
};

// Sends a push to every device a user has subscribed, honouring their saved mute settings
export const sendPushToUser = async (userId, { chatId, title, body, url, icon }) => {
  if (!isPushConfigured()) return;
  const subs = await PushSubscription.find({ user: userId });

  await Promise.all(
    subs.map(async (sub) => {
      const { enabled, preview, mutedChats } = sub.settings;
      if (!enabled || mutedChats.includes(chatId)) return;

      const payload = JSON.stringify({
        title,
        body: preview ? body : "New message",
        tag: chatId,
        url,
        icon,
      });
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload
        );
      } catch (err) {
        // 404/410 mean the browser dropped the subscription
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.log("Push failed", err.statusCode || err.message);
        }
      }
    })
  );
};
