import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import router from "./Routes/User.routes.js";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";

dotenv.config();
const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use("/api", router);

app.get("/", (req, res) => {
  console.log("🌐 HTTP GET / - Server is alive");
  res.send("Backend is running 🚀");
});
app.post("/api/test", (req, res) => {
  console.log("📨 POST /api/test hit with data:", req.body);
  res.json({ message: "Test route works" });
});

const server = createServer(app);

const wss = new WebSocketServer({ server });

const redisClient = createClient({
  url: process.env.REDIS_URL, 
});

redisClient.on("error", (err) => console.error("❌ Redis Error:", err));

await redisClient.connect();
console.log("✅ Connected to Redis"); 

function getDistanceInMeters(loc1, loc2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = (loc1.lat * Math.PI) / 180;
  const φ2 = (loc2.lat * Math.PI) / 180;
  const Δφ = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const Δλ = ((loc2.lng - loc1.lng) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // distance in meters
}

wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      console.log("📥 Incoming data:", data);

      await redisClient.geoAdd("users", {
        longitude: data.longitude,
        latitude: data.latitude,
        member: data.userId,
      });
      console.log(`📍 Redis GEO updated for ${data.userId}`);

      const ttl = data.speed > 5 ? 10 : 30;
      await redisClient.set(`userData:${data.userId}`, JSON.stringify(data), { EX: ttl });
      console.log(`💾 Redis user data set for ${data.userId} with TTL ${ttl}s`);

      const nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, 50, "m", { COUNT: 50 });
      console.log(`🔎 Nearby users of ${data.userId}:`, nearbyUserIds);

      const threats = [];
      const keys = nearbyUserIds.map(uid => `userData:${uid}`);
      const usersData = await redisClient.mGet(keys);

      for (let i = 0; i < nearbyUserIds.length; i++) {
        const uid = nearbyUserIds[i];
        if (uid === data.userId) continue;

        const userInfoRaw = usersData[i];
        if (!userInfoRaw) continue;
        const userInfo = JSON.parse(userInfoRaw);

        const projectionTime = 2;
        const headingChangeSelf = data.gyro?.z || 0;
        const headingChangeOther = userInfo.gyro?.z || 0;

        const projectedLat1 = data.latitude + Math.sin((data.heading + headingChangeSelf * projectionTime) * Math.PI / 180) * data.speed * 0.00001 * projectionTime;
        const projectedLng1 = data.longitude + Math.cos((data.heading + headingChangeSelf * projectionTime) * Math.PI / 180) * data.speed * 0.00001 * projectionTime;

        const projectedLat2 = userInfo.latitude + Math.sin((userInfo.heading + headingChangeOther * projectionTime) * Math.PI / 180) * userInfo.speed * 0.00001 * projectionTime;
        const projectedLng2 = userInfo.longitude + Math.cos((userInfo.heading + headingChangeOther * projectionTime) * Math.PI / 180) * userInfo.speed * 0.00001 * projectionTime;

        const distance = getDistanceInMeters({ lat: projectedLat1, lng: projectedLng1 }, { lat: projectedLat2, lng: projectedLng2 });

        const accelMagnitudeSelf = Math.sqrt(data.accel.x ** 2 + data.accel.y ** 2);
        const accelMagnitudeOther = Math.sqrt(userInfo.accel.x ** 2 + userInfo.accel.y ** 2);
        const projectedSpeedSelf = Math.max(data.speed + accelMagnitudeSelf * projectionTime, 0);
        const projectedSpeedOther = Math.max(userInfo.speed + accelMagnitudeOther * projectionTime, 0);

        if (distance < 10 && projectedSpeedSelf > 0 && projectedSpeedOther > 0) {
          threats.push([data.userId, uid]);
          console.log(`⚠️ Threat detected between ${data.userId} and ${uid}`);
        }
      }

      const threatPositions = [];
      for (const [user1, user2] of threats) {
        const userData1 = JSON.parse(await redisClient.get(`userData:${user1}`));
        const userData2 = JSON.parse(await redisClient.get(`userData:${user2}`));

        threatPositions.push({
          user1: { id: user1, lat: userData1.latitude, lng: userData1.longitude },
          user2: { id: user2, lat: userData2.latitude, lng: userData2.longitude },
        });
      }

      console.log("🚨 All threat positions:", threatPositions);

      ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: threatPositions }));
      console.log("📤 Threat data sent to frontend");
    } catch (err) {
      console.error("❌ WebSocket message handling error:", err);
    }
  });

  ws.on("close", () => console.log("❌ WebSocket client disconnected"));
});




mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
