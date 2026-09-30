import { Router } from "express";
import {
  getPublicKey,
  subscribe,
  unsubscribe,
} from "../controllers/PushController.js";
import { verifyToken } from "../middlewares/AuthMiddleware.js";

const pushRoutes = Router();
pushRoutes.get("/public-key", getPublicKey);
pushRoutes.post("/subscribe", verifyToken, subscribe);
pushRoutes.post("/unsubscribe", verifyToken, unsubscribe);

export default pushRoutes;
