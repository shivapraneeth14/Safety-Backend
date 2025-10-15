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

// ---- Configurable thresholds (override via environment) ----
const CONFIG = {
  NEARBY_RADIUS_METERS: Number(process.env.NEARBY_RADIUS_METERS ?? 75),
  PROJECTION_TIME_SECONDS: Number(process.env.PROJECTION_TIME_SECONDS ?? 2),
  THREAT_DISTANCE_METERS: Number(process.env.THREAT_DISTANCE_METERS ?? 12),
  MIN_MOVING_SPEED_MS: Number(process.env.MIN_MOVING_SPEED_MS ?? 0.1),
  ANGULAR_VEL_HIGH_DEG_S: Number(process.env.ANGULAR_VEL_HIGH_DEG_S ?? 45),
  UNCERTAINTY_INFLATION_METERS: Number(process.env.UNCERTAINTY_INFLATION_METERS ?? 5),
  BLIND_SPOT_RADIUS_BOOST_METERS: Number(process.env.BLIND_SPOT_RADIUS_BOOST_METERS ?? 8),
  STALE_MS: Number(process.env.STALE_MS ?? 4000),
};

function normalizeHeadingDeg(value) {
  if (!Number.isFinite(value)) return 0;
  let h = value % 360;
  if (h < 0) h += 360;
  return h;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Forward geodesic projection using bearing (deg) and distance (m)
function projectPoint(latDeg, lonDeg, bearingDeg, distanceMeters) {
  const R = 6371e3;
  const φ1 = (latDeg * Math.PI) / 180;
  const λ1 = (lonDeg * Math.PI) / 180;
  const θ = (bearingDeg * Math.PI) / 180;
  const δ = distanceMeters / R;

  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);

  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  const lat2 = (φ2 * 180) / Math.PI;
  let lon2 = (λ2 * 180) / Math.PI;
  if (lon2 > 180) lon2 -= 360;
  if (lon2 < -180) lon2 += 360;
  return { lat: lat2, lng: lon2 };
}

wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");

  ws.on("message", async (message) => {
    try {
      const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
      const data = JSON.parse(raw);
      if (!data || typeof data.userId !== "string" || data.userId.trim() === "") {
        console.error("❌ Missing or invalid userId in WebSocket payload. Raw:", raw);
        ws.send(JSON.stringify({ status: "error", reason: "missing userId" }));
        return;
      }
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        console.error("❌ Missing or invalid coordinates in WebSocket payload:", data);
        ws.send(JSON.stringify({ status: "error", reason: "invalid coordinates" }));
        return;
      }
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

      // Inflate nearby radius during blind-spot scenarios (e.g., high angular velocity)
      const isSuddenTurn = Math.abs(data.gyro?.z ?? 0) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;
      const dynamicRadius = CONFIG.NEARBY_RADIUS_METERS + (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);
      const nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, dynamicRadius, "m", { COUNT: 50 });
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

        // Skip stale opponents to reduce ghost threats
        const now = Date.now();
        const userInfoTs = new Date(userInfo.timestamp || 0).getTime();
        if (!Number.isFinite(userInfoTs) || now - userInfoTs > CONFIG.STALE_MS) continue;

        const projectionTime = CONFIG.PROJECTION_TIME_SECONDS;
        const gyroZSelf = Number.isFinite(data.gyro?.z) ? data.gyro.z : 0;
        const gyroZOther = Number.isFinite(userInfo.gyro?.z) ? userInfo.gyro.z : 0;
        const headingSelf = normalizeHeadingDeg((data.heading ?? 0) + clamp(gyroZSelf, -90, 90) * projectionTime);
        const headingOther = normalizeHeadingDeg((userInfo.heading ?? 0) + clamp(gyroZOther, -90, 90) * projectionTime);

        const accelMagnitudeSelf = Math.sqrt((data.accel?.x ?? 0) ** 2 + (data.accel?.y ?? 0) ** 2 + (data.accel?.z ?? 0) ** 2);
        const accelMagnitudeOther = Math.sqrt((userInfo.accel?.x ?? 0) ** 2 + (userInfo.accel?.y ?? 0) ** 2 + (userInfo.accel?.z ?? 0) ** 2);
        const projectedSpeedSelf = Math.max((data.speed ?? 0) + accelMagnitudeSelf * projectionTime, 0);
        const projectedSpeedOther = Math.max((userInfo.speed ?? 0) + accelMagnitudeOther * projectionTime, 0);

        const displacementSelf = projectedSpeedSelf * projectionTime; // meters
        const displacementOther = projectedSpeedOther * projectionTime; // meters

        const p1 = projectPoint(data.latitude, data.longitude, headingSelf, displacementSelf);
        const p2 = projectPoint(userInfo.latitude, userInfo.longitude, headingOther, displacementOther);

        let distance = getDistanceInMeters({ lat: p1.lat, lng: p1.lng }, { lat: p2.lat, lng: p2.lng });

        // Inflate distance threshold under sudden turning uncertainty
        if (Math.abs(gyroZSelf) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S || Math.abs(gyroZOther) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S) {
          distance -= CONFIG.UNCERTAINTY_INFLATION_METERS;
        }

        if (
          distance < CONFIG.THREAT_DISTANCE_METERS &&
          projectedSpeedSelf > CONFIG.MIN_MOVING_SPEED_MS &&
          projectedSpeedOther > CONFIG.MIN_MOVING_SPEED_MS
        ) {
          threats.push([data.userId, uid]);
          console.log(`⚠️ Threat detected between ${data.userId} and ${uid}`);
        }
      }

      const threatPositions = [];
      for (const [user1, user2] of threats) {
        if (user1 !== data.userId) continue;

        const userData1Raw = await redisClient.get(`userData:${user1}`);
        const userData2Raw = await redisClient.get(`userData:${user2}`);
        if (!userData1Raw || !userData2Raw) continue;
        const userData1 = JSON.parse(userData1Raw);
        const userData2 = JSON.parse(userData2Raw);

        // Push only the opposite vehicle's location to the client
        threatPositions.push({ id: user2, lat: userData2.latitude, lng: userData2.longitude });
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