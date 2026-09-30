import { Router } from "express";
import {
  deleteFileMessage,
  getMessages,
  searchMessages,
  uploadFile,
} from "../controllers/MessagesController.js";
import { verifyToken } from "../middlewares/AuthMiddleware.js";
import multer from "multer";

const messagesRoutes = Router();
const upload = multer({ dest: "uploads/files/" });
messagesRoutes.post("/get-messages", verifyToken, getMessages);
messagesRoutes.post(
  "/upload-file",
  verifyToken,
  upload.single("file"),
  uploadFile
);

messagesRoutes.delete("/delete-file/:messageId", verifyToken, deleteFileMessage);

messagesRoutes.post("/search", verifyToken, searchMessages);

export default messagesRoutes;
