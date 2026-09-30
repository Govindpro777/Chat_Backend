import PushSubscription from "../model/PushSubscriptionModel.js";
import { isPushConfigured } from "../lib/push.js";

export const getPublicKey = (req, res) => {
  if (!isPushConfigured()) return res.status(503).send("Push is not configured");
  return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};

// Creates or updates this device's subscription and its notification settings
export const subscribe = async (req, res) => {
  try {
    const { subscription, settings } = req.body;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).send("Invalid subscription");
    }
    await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        user: req.userId,
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
        settings: {
          enabled: settings?.enabled ?? true,
          preview: settings?.preview ?? true,
          mutedChats: Array.isArray(settings?.mutedChats) ? settings.mutedChats : [],
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(200).send("Subscribed");
  } catch (err) {
    console.log(err);
    return res.status(500).send("Internal Server Error");
  }
};

export const unsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await PushSubscription.deleteOne({ endpoint, user: req.userId });
    }
    return res.status(200).send("Unsubscribed");
  } catch (err) {
    console.log(err);
    return res.status(500).send("Internal Server Error");
  }
};
