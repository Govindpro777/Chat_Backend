import { Router } from "express";
import {
  createChannel,
  deleteChannel,
  getChannelDetails,
  getChannelMessages,
  getUserChannels,
  leaveChannel,
  updateChannel,
} from "../controllers/ChannelControllers.js";
import { verifyToken } from "../middlewares/AuthMiddleware.js";

const channelRoutes = Router();

channelRoutes.post("/create-channel", verifyToken, createChannel);
channelRoutes.get("/get-user-channels", verifyToken, getUserChannels);
channelRoutes.get(
  "/get-channel-messages/:channelId",
  verifyToken,
  getChannelMessages
);

channelRoutes.get("/details/:channelId", verifyToken, getChannelDetails);
channelRoutes.put("/update/:channelId", verifyToken, updateChannel);
channelRoutes.delete("/delete/:channelId", verifyToken, deleteChannel);
channelRoutes.post("/leave/:channelId", verifyToken, leaveChannel);

export default channelRoutes;
