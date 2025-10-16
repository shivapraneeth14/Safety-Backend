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
  PROJECTION_TIME_SECONDS: Number(process.env.PROJECTION_TIME_SECONDS ?? 3),
  THREAT_DISTANCE_METERS: Number(process.env.THREAT_DISTANCE_METERS ?? 15),
  MIN_MOVING_SPEED_MS: Number(process.env.MIN_MOVING_SPEED_MS ?? 0.1),
  ANGULAR_VEL_HIGH_DEG_S: Number(process.env.ANGULAR_VEL_HIGH_DEG_S ?? 45),
  UNCERTAINTY_INFLATION_METERS: Number(process.env.UNCERTAINTY_INFLATION_METERS ?? 5),
  BLIND_SPOT_RADIUS_BOOST_METERS: Number(process.env.BLIND_SPOT_RADIUS_BOOST_METERS ?? 8),
  STALE_MS: Number(process.env.STALE_MS ?? 4000),
  TTC_MAX_SECONDS: Number(process.env.TTC_MAX_SECONDS ?? 3),
  CLOSING_SPEED_STRONG_MS: Number(process.env.CLOSING_SPEED_STRONG_MS ?? 10),
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

// Approximate local meters conversion around a reference latitude
function degreesToMetersVector(refLatDeg, dLatDeg, dLonDeg) {
  const metersPerDegLat = 111320; // approximate
  const metersPerDegLon = 111320 * Math.cos((refLatDeg * Math.PI) / 180);
  return {
    x: dLonDeg * metersPerDegLon, // east
    y: dLatDeg * metersPerDegLat, // north
  };
}

// Compute TTC and closest point of approach in meters using relative motion in local ENU
function computeTtcAndCpaMeters(self, other) {
  // self, other: { lat, lng, speed, heading }
  const refLat = self.lat;
  const dLat = other.lat - self.lat;
  const dLon = other.lng - self.lng;
  const r = degreesToMetersVector(refLat, dLat, dLon); // relative position (other - self)

  const toRad = (deg) => (deg * Math.PI) / 180;
  const vSelf = {
    x: (self.speed ?? 0) * Math.cos(toRad(self.heading ?? 0)),
    y: (self.speed ?? 0) * Math.sin(toRad(self.heading ?? 0)),
  };
  const vOther = {
    x: (other.speed ?? 0) * Math.cos(toRad(other.heading ?? 0)),
    y: (other.speed ?? 0) * Math.sin(toRad(other.heading ?? 0)),
  };
  const v = { x: vOther.x - vSelf.x, y: vOther.y - vSelf.y }; // relative velocity (other - self)

  const rDotV = r.x * v.x + r.y * v.y;
  const vMag2 = v.x * v.x + v.y * v.y;
  if (vMag2 <= 1e-6) {
    return { ttc: Infinity, cpa: Math.hypot(r.x, r.y), closingSpeed: 0 };
  }
  // positive closing speed means approaching
  const closingSpeed = -rDotV / Math.hypot(r.x, r.y);
  let ttc = -rDotV / vMag2; // seconds until closest approach
  if (ttc < 0) ttc = Infinity; // already diverging
  const cpaVec = { x: r.x + v.x * ttc, y: r.y + v.y * ttc };
  const cpa = Math.hypot(cpaVec.x, cpaVec.y);
  return { ttc, cpa, closingSpeed };
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

      // Store geo + user data in Redis (same as before)
      await redisClient.geoAdd("users", {
        longitude: data.longitude,
        latitude: data.latitude,
        member: data.userId,
      });
      const ttl = data.speed > 5 ? 10 : 30;
      await redisClient.set(`userData:${data.userId}`, JSON.stringify(data), { EX: ttl });
  
      // Determine dynamic nearby radius (preserve your blind-spot boost behavior)
      const gyroZRaw = Number(data.gyro?.z ?? 0);
      // If gyro likely in rad/s, convert to deg/s heuristically if small magnitude suggests rad units
      let gyroZDeg = gyroZRaw;
      if (Math.abs(gyroZRaw) < 0.5) {
        // likely rad/s -> convert
        gyroZDeg = gyroZRaw * (180 / Math.PI);
      }
      const isSuddenTurn = Math.abs(gyroZDeg) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;
      const nearbyRadius = CONFIG.NEARBY_RADIUS_METERS + (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);
  
      const nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
      console.log(`🔎 Nearby users of ${data.userId}:`, nearbyUserIds);

      // Build keys and fetch data in same order
      const otherIds = nearbyUserIds.filter(uid => uid !== data.userId);
      if (otherIds.length === 0) {
        ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: [] }));
        return;
      }
  
      const keys = otherIds.map(uid => `userData:${uid}`);
      const usersData = await redisClient.mGet(keys);

      // Helper: convert lat/lon delta into local meters (equirectangular approx)
      const metersPerDegLat = 111320; // approx
      function lonDegToMetersFactor(latDeg) {
        return Math.cos((latDeg * Math.PI) / 180) * 111320;
      }
  
      // Helper: get current time-ms and skip stale
      const now = Date.now();
      const threats = [];
  
      // Our function to compute CPA between two straight-line motions.
      // Positions are in meters in local frame; velocities are m/s.
      function computeCPA(posA, velA, posB, velB, maxT) {
        // relative pos and vel
        const r0x = posA.x - posB.x;
        const r0y = posA.y - posB.y;
        const vx = velA.x - velB.x;
        const vy = velA.y - velB.y;
  
        const vDotV = vx * vx + vy * vy;
        let tStar = 0;
        if (vDotV <= 1e-6) {
          tStar = 0; // nearly same velocity => CPA now
        } else {
          tStar = - (r0x * vx + r0y * vy) / vDotV;
          tStar = Math.max(0, Math.min(maxT, tStar));
        }
  
        const cpx = (posA.x + velA.x * tStar + posB.x + velB.x * tStar) / 2; // midpoint of positions at tStar (optional)
        const cpy = (posA.y + velA.y * tStar + posB.y + velB.y * tStar) / 2;
        const distX = (posA.x + velA.x * tStar) - (posB.x + velB.x * tStar);
        const distY = (posA.y + velA.y * tStar) - (posB.y + velB.y * tStar);
        const dist = Math.sqrt(distX * distX + distY * distY);
  
        return { tStar, dist, cpx, cpy, posAAtT: { x: posA.x + velA.x * tStar, y: posA.y + velA.y * tStar }, posBAtT: { x: posB.x + velB.x * tStar, y: posB.y + velB.y * tStar } };
      }
  
      // Convert one user's lat/lon & heading+speed to local pos/vel
      function prepareState(refLat, user) {
        const lat = user.latitude;
        const lon = user.longitude;
        const dlat = lat - refLat;
        const avgLat = (refLat + lat) / 2;
        const metersPerDegLon = lonDegToMetersFactor(avgLat);
  
        const x = dlat * metersPerDegLat; // north (+)
        const y = (lon - data.longitude) * metersPerDegLon; // east (+)
        // Wait — above uses data.longitude; we will build relative position from data as origin below.
        return { lat, lon, x, y, metersPerDegLon, avgLat };
      }
  
      // We'll compute everything relative to the incoming device `data` as origin
      // prepare base factors
      const baseLat = data.latitude;
      const baseLon = data.longitude;
      const baseMetersPerDegLon = lonDegToMetersFactor(baseLat);
  
      // Build base pos and velocity for 'self' (data)
      const headingSelfRad = ((normalizeHeadingDeg(Number(data.heading ?? 0))) * Math.PI) / 180;
      const speedSelf = Math.max(0, Number(data.speed ?? 0));
      const velSelf = {
        x: speedSelf * Math.cos(headingSelfRad), // north component (m/s)
        y: speedSelf * Math.sin(headingSelfRad)  // east component (m/s)
      };
      // posSelf at origin (0,0) in meters relative frame
      const posSelf = { x: 0, y: 0 };
  
      for (let i = 0; i < otherIds.length; i++) {
        try {
          const uid = otherIds[i];
        const userInfoRaw = usersData[i];
        if (!userInfoRaw) continue;
        const userInfo = JSON.parse(userInfoRaw);

          // Skip stale opponents
          const userInfoTs = new Date(userInfo.timestamp || 0).getTime();
          if (!Number.isFinite(userInfoTs) || now - userInfoTs > CONFIG.STALE_MS) continue;
  
          // Compute relative position (meters) of userInfo from data position (origin)
          const dLatDeg = userInfo.latitude - baseLat;
          const dLonDeg = userInfo.longitude - baseLon;
          const xOther = dLatDeg * metersPerDegLat; // north (m)
          const yOther = dLonDeg * baseMetersPerDegLon; // east (m)
  
          // Build velocity vector for other (m/s) from its heading & speed
          const headingOther = normalizeHeadingDeg(Number(userInfo.heading ?? 0));
          const headingOtherRad = (headingOther * Math.PI) / 180;
          const speedOther = Math.max(0, Number(userInfo.speed ?? 0));
          const velOther = {
            x: speedOther * Math.cos(headingOtherRad), // north component
            y: speedOther * Math.sin(headingOtherRad)  // east component
          };
  
          // Optionally inflate threshold by reported horizontalAccuracy (meters)
          const horizAccSelf = Number(data.horizontalAccuracy ?? data.accuracy ?? 0);
          const horizAccOther = Number(userInfo.horizontalAccuracy ?? userInfo.accuracy ?? 0);
          const accInflation = (Number.isFinite(horizAccSelf) ? horizAccSelf : 0) + (Number.isFinite(horizAccOther) ? horizAccOther : 0) + CONFIG.UNCERTAINTY_INFLATION_METERS;
  
          // Compute CPA (max projection window = CONFIG.PROJECTION_TIME_SECONDS)
          const cpa = computeCPA(posSelf, velSelf, { x: xOther, y: yOther }, velOther, CONFIG.PROJECTION_TIME_SECONDS);
  
          // If CPA distance below threat threshold + inflation AND both moving (above min speed) or one is high accel indicating collision
          const effectiveThreatDistance = CONFIG.THREAT_DISTANCE_METERS + accInflation;
  
          const isMovingBoth = (speedSelf > CONFIG.MIN_MOVING_SPEED_MS) && (speedOther > CONFIG.MIN_MOVING_SPEED_MS);
          // Check sudden decel events from accel (best-effort). Remove gravity estimate: if abs(z) ~9.8 then linear ≈ magnitude - 9.8
          const accelSelfMag = Math.sqrt((data.accel?.x ?? 0) ** 2 + (data.accel?.y ?? 0) ** 2 + (data.accel?.z ?? 0) ** 2);
          const accelOtherMag = Math.sqrt((userInfo.accel?.x ?? 0) ** 2 + (userInfo.accel?.y ?? 0) ** 2 + (userInfo.accel?.z ?? 0) ** 2);
          const linAccSelf = Math.max(0, accelSelfMag - 9.5); // rough linear accel estimate
          const linAccOther = Math.max(0, accelOtherMag - 9.5);
  
          // final decision: CPA distance less than threshold and either both moving or a strong accel event
          if (cpa.dist <= effectiveThreatDistance && (isMovingBoth || linAccSelf > 3 || linAccOther > 3)) {
            // convert CPA pos back to lat/lon for reporting
            // pos (north meters) -> delta degrees lat = x / metersPerDegLat
            const cpaLatSelf = baseLat + (cpa.posAAtT.x / metersPerDegLat);
            const cpaLonSelf = baseLon + (cpa.posAAtT.y / baseMetersPerDegLon);
  
            const cpaLatOther = baseLat + (cpa.posBAtT.x / metersPerDegLat);
            const cpaLonOther = baseLon + (cpa.posBAtT.y / baseMetersPerDegLon);
  
            // Prepare threat object
            threats.push({
              threatWith: uid,
              currentOther: { id: uid, lat: userInfo.latitude, lng: userInfo.longitude },
              cpa: {
                timeToCPA_s: Number(cpa.tStar.toFixed(2)),
                distance_m: Number(cpa.dist.toFixed(2)),
                selfPosAtCPA: { lat: Number(cpaLatSelf.toFixed(7)), lng: Number(cpaLonSelf.toFixed(7)) },
                otherPosAtCPA: { lat: Number(cpaLatOther.toFixed(7)), lng: Number(cpaLonOther.toFixed(7)) }
              },
              metadata: {
                speedSelf: speedSelf,
                speedOther: speedOther,
                horizAccInflation_m: Number(accInflation.toFixed(2))
              }
            });
  
            console.log(`⚠️ Threat detected between ${data.userId} and ${uid} — CPA dist ${cpa.dist.toFixed(2)}m in ${cpa.tStar.toFixed(2)}s`);
          }
        } catch (innerErr) {
          console.error("❌ Error processing nearby user:", otherIds[i], innerErr);
          continue;
        }
      }
  
      // Send only the threats where the origin was the sender (data.userId)
      const threatPositions = threats.map(t => ({
        id: t.currentOther.id,
        lat: t.currentOther.lat,
        lng: t.currentOther.lng,
        cpa: t.cpa
      }));
      

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
