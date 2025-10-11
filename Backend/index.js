import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import router from "./Routes/User.routes.js";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();
const app = express();

// Middleware
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use("/api", router);

// Test Route
app.get("/", (req, res) => {
  console.log("🌐 HTTP GET / - Server is alive");
  res.send("Backend is running 🚀");
});

app.post("/api/test", (req, res) => {
  console.log("📨 POST /api/test hit with data:", req.body);
  res.json({ message: "Test route works" });
});

// Create HTTP server
const server = createServer(app);

// Initialize WebSocket server
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("🔗 New client connected via WebSocket");

  // Send a welcome message to the client
  ws.send(JSON.stringify({ message: "Welcome to WebSocket server!" }));
  console.log("📤 Sent welcome message to client");

  ws.on("message", (message) => {
    console.log("📥 Received message from client:", message.toString());

    try {
      const data = JSON.parse(message);
      console.log("📊 Parsed vehicle data:", data);

      // Example: here you could save to DB or calculate risk
      // For now, just log it
      console.log("✅ Data logged successfully for processing");

      // Send acknowledgment back to client
      ws.send(JSON.stringify({ status: "received", timestamp: new Date() }));
      console.log("📤 Sent acknowledgment to client");
    } catch (err) {
      console.error("❌ Error parsing message:", err);
    }
  });

  ws.on("close", () => {
    console.log("❌ Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
  });
});

// MongoDB Connection + start server
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
