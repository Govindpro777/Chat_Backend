import { Router } from "express";
import { getIceServers } from "../controllers/CallController.js";
import { verifyToken } from "../middlewares/AuthMiddleware.js";

const callRoutes = Router();
callRoutes.get("/ice-servers", verifyToken, getIceServers);

export default callRoutes;
