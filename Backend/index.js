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

// Track active WebSocket connections by userId
const userSockets = new Map();

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

      // Basic validation
      if (!data || typeof data.userId !== "string" || data.userId.trim() === "") {
        ws.send(JSON.stringify({ status: "error", reason: "missing userId" }));
        return;
      }
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        ws.send(JSON.stringify({ status: "error", reason: "invalid coordinates" }));
        return;
      }

      // Register this socket for this userId (so we can push alerts to them)
      userSockets.set(data.userId, ws);

      // Persist latest geo & payload in Redis
      await redisClient.geoAdd("users", {
        longitude: data.longitude,
        latitude: data.latitude,
        member: data.userId,
      });
      const ttl = data.speed > 5 ? 10 : 30;
      await redisClient.set(`userData:${data.userId}`, JSON.stringify(data), { EX: ttl });

      // dynamic nearby radius (keeps your earlier logic)
      const gyroZRaw = Number(data.gyro?.z ?? 0);
      let gyroZDeg = gyroZRaw;
      if (Math.abs(gyroZRaw) < 0.5) gyroZDeg = gyroZRaw * (180 / Math.PI);
      const isSuddenTurn = Math.abs(gyroZDeg) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;
      const nearbyRadius = CONFIG.NEARBY_RADIUS_METERS + (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);

      // fetch nearby users (members)
      const nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
      const otherIds = nearbyUserIds.filter(uid => uid !== data.userId);
      if (otherIds.length === 0) {
        ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: [] }));
        return;
      }

      const keys = otherIds.map(uid => `userData:${uid}`);
      const usersData = await redisClient.mGet(keys);

      // helper functions
      const deg2rad = d => (d * Math.PI) / 180;
      const rad2deg = r => (r * 180) / Math.PI;
      const haversineMeters = (lat1, lon1, lat2, lon2) => {
        const R = 6371e3;
        const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2);
        const Δφ = deg2rad(lat2 - lat1), Δλ = deg2rad(lon2 - lon1);
        const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      const headingDiff = (h1, h2) => {
        let d = Math.abs((h1 ?? 0) - (h2 ?? 0));
        if (d > 180) d = 360 - d;
        return d;
      };

      // compute CPA helper using local metric projection (works for short distances)
      function computeCPA_local(selfPos, selfVel, otherPos, otherVel, maxT) {
        const r0x = selfPos.x - otherPos.x;
        const r0y = selfPos.y - otherPos.y;
        const vx = selfVel.x - otherVel.x;
        const vy = selfVel.y - otherVel.y;
        const vDotV = vx * vx + vy * vy;
        let tStar = 0;
        if (vDotV > 1e-6) {
          tStar = - (r0x * vx + r0y * vy) / vDotV;
          tStar = Math.max(0, Math.min(maxT, tStar));
        }
        const aPosX = selfPos.x + selfVel.x * tStar;
        const aPosY = selfPos.y + selfVel.y * tStar;
        const bPosX = otherPos.x + otherVel.x * tStar;
        const bPosY = otherPos.y + otherVel.y * tStar;
        const dist = Math.hypot(aPosX - bPosX, aPosY - bPosY);
        return { tStar, dist, selfAtT: { x: aPosX, y: aPosY }, otherAtT: { x: bPosX, y: bPosY } };
      }

      // We'll use the incoming device as origin in a local ENU frame (north=x, east=y)
      const baseLat = data.latitude;
      const baseLon = data.longitude;
      const metersPerDegLat = 111320;
      const metersPerDegLonBase = Math.cos(deg2rad(baseLat)) * 111320;

      const headingSelf = normalizeHeadingDeg(Number(data.heading ?? 0));
      const headingSelfRad = deg2rad(headingSelf);
      const speedSelf = Math.max(0, Number(data.speed ?? 0));
      const velSelf = { x: speedSelf * Math.cos(headingSelfRad), y: speedSelf * Math.sin(headingSelfRad) };
      const posSelf = { x: 0, y: 0 };

      const now = Date.now();
      const threats = [];

      // thresholds (local variables, easy to tweak)
      const MIN_SPEED_FOR_INTERSECTION = 2.78; // 10 km/h in m/s
      const INTERSECTION_DIST_M = 8; // slightly wider threshold for intersection CPA
      const REAR_TTC_THRESH = CONFIG.TTC_MAX_SECONDS ?? 3;
      const REAR_CLOSING_SPEED_MIN = 0.5; // m/s closing speed to consider
      const OVERTAKE_SIDE_MAX_M = 4; // lateral offset threshold for overtake
      const WRONG_DIR_RADIUS_M = 30;

      // Iterate nearby vehicles
      for (let i = 0; i < otherIds.length; i++) {
        try {
          const uid = otherIds[i];
          const raw = usersData[i];
          if (!raw) continue;
          const other = JSON.parse(raw);

          // Skip stale
          const otherTs = new Date(other.timestamp || 0).getTime();
          if (!Number.isFinite(otherTs) || now - otherTs > CONFIG.STALE_MS) continue;

          // compute relative pos in meters
          const dLat = other.latitude - baseLat;
          const dLon = other.longitude - baseLon;
          const xOther = dLat * metersPerDegLat; // north
          const yOther = dLon * metersPerDegLonBase; // east
          const posOther = { x: xOther, y: yOther };

          // velocities from heading & speed
          const headingOther = normalizeHeadingDeg(Number(other.heading ?? 0));
          const headingOtherRad = deg2rad(headingOther);
          const speedOther = Math.max(0, Number(other.speed ?? 0));
          const velOther = { x: speedOther * Math.cos(headingOtherRad), y: speedOther * Math.sin(headingOtherRad) };

          // geometric & kinematic metrics
          const dist = haversineMeters(baseLat, baseLon, other.latitude, other.longitude);
          const hdiff = headingDiff(headingSelf, headingOther);

          // -------------- Intersection (T/L) detection --------------
          // Condition: both moving > MIN_SPEED_FOR_INTERSECTION, heading roughly perpendicular,
          // and their projected positions in PROJECTION_TIME_SECONDS are within INTERSECTION_DIST_M
          if (speedSelf >= MIN_SPEED_FOR_INTERSECTION && speedOther >= MIN_SPEED_FOR_INTERSECTION && hdiff >= 60 && hdiff <= 120) {
            const cpa = computeCPA_local(posSelf, velSelf, posOther, velOther, CONFIG.PROJECTION_TIME_SECONDS);
            if (cpa.dist <= INTERSECTION_DIST_M && cpa.tStar <= (CONFIG.TTC_MAX_SECONDS ?? 3)) {
              // send threat to self (source = other)
              const payloadSelf = {
                type: "intersection_collision",
                sourceVehicle: { userId: other.userId ?? uid, latitude: other.latitude, longitude: other.longitude, speed: speedOther, heading: headingOther },
                distance_m: Number(cpa.dist.toFixed(2)),
                timeToCPA_s: Number(cpa.tStar.toFixed(2)),
                message: "⚠️ Possible T/L intersection collision"
              };
              threats.push(payloadSelf);

              // send alert to other vehicle as well (if connected)
              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "intersection_collision",
                  sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                  distance_m: Number(cpa.dist.toFixed(2)),
                  timeToCPA_s: Number(cpa.tStar.toFixed(2)),
                  message: "⚠️ Possible T/L intersection collision"
                };
                wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
              }
              // continue to next other vehicle (already flagged)
              continue;
            }
          }

          // -------------- Rear-end detection (front/back) --------------
          // Use CPA + TTC/closing speed to infer risk of rear collision.
          // If vehicles are approximately aligned (heading diff < 30),
          // and relative motion projects a small TTC and closing speed > threshold -> rear risk
          if (hdiff <= 30) {
            const cpaRear = computeCPA_local(posSelf, velSelf, posOther, velOther, CONFIG.PROJECTION_TIME_SECONDS);
            // compute approximate closing speed along line of approach
            // closingSpeed approx = (relative position) dot (relative velocity) / distance (signed)
            const r = { x: posOther.x - posSelf.x, y: posOther.y - posSelf.y };
            const vrel = { x: velOther.x - velSelf.x, y: velOther.y - velSelf.y };
            const rMag = Math.hypot(r.x, r.y);
            let closingSpeed = 0;
            if (rMag > 0.001) {
              closingSpeed = - (r.x * vrel.x + r.y * vrel.y) / rMag; // positive => approaching
            }
            if (closingSpeed > REAR_CLOSING_SPEED_MIN && cpaRear.tStar <= REAR_TTC_THRESH && cpaRear.dist <= CONFIG.THREAT_DISTANCE_METERS + CONFIG.UNCERTAINTY_INFLATION_METERS) {
              // Determine which is front and which is rear by projecting relative long component along self heading
              const alongSelf = r.x * Math.cos(headingSelfRad) + r.y * Math.sin(headingSelfRad); // >0 => other ahead of self

              const wsOther = userSockets.get(uid);
              if (alongSelf > 0) {
                // Self is trailing, warn self; inform other that a vehicle behind is closing
                const payloadSelf = {
                  type: "rear_collision",
                  sourceVehicle: { userId: other.userId ?? uid, latitude: other.latitude, longitude: other.longitude, speed: speedOther, heading: headingOther },
                  distance_m: Number(cpaRear.dist.toFixed(2)),
                  timeToCPA_s: Number(cpaRear.tStar.toFixed(2)),
                  message: "🚨 Risk of rear-end collision — vehicle ahead is slowing / you are closing fast"
                };
                threats.push(payloadSelf);

                if (wsOther && wsOther.readyState === wsOther.OPEN) {
                  const payloadOther = {
                    type: "rear_collision",
                    sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                    distance_m: Number(cpaRear.dist.toFixed(2)),
                    timeToCPA_s: Number(cpaRear.tStar.toFixed(2)),
                    message: "🚨 Risk of rear-end collision — vehicle behind is closing fast"
                  };
                  wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                }
              } else {
                // Self is leading, warn the trailing other; do not push a rear alert to self
                if (wsOther && wsOther.readyState === wsOther.OPEN) {
                  const payloadOther = {
                    type: "rear_collision",
                    sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                    distance_m: Number(cpaRear.dist.toFixed(2)),
                    timeToCPA_s: Number(cpaRear.tStar.toFixed(2)),
                    message: "🚨 Risk of rear-end collision — you are closing fast on a vehicle ahead"
                  };
                  wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                }
              }
              continue;
            }
          }

          // -------------- Wrong-direction detection --------------
          // If headings differ by almost 180 and within a reasonable radius => wrong way
          if (hdiff >= 150 && dist <= WRONG_DIR_RADIUS_M && (speedSelf > CONFIG.MIN_MOVING_SPEED_MS || speedOther > CONFIG.MIN_MOVING_SPEED_MS)) {
            const payloadSelf = {
              type: "wrong_direction",
              sourceVehicle: { userId: other.userId ?? uid, latitude: other.latitude, longitude: other.longitude, speed: speedOther, heading: headingOther },
              distance_m: Number(dist.toFixed(2)),
              message: "🚫 Vehicle going in opposite direction"
            };
            threats.push(payloadSelf);

            const wsOther = userSockets.get(uid);
            if (wsOther && wsOther.readyState === wsOther.OPEN) {
              const payloadOther = {
                type: "wrong_direction",
                sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                distance_m: Number(dist.toFixed(2)),
                message: "🚫 Nearby vehicle moving in opposite direction"
              };
              wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
            }
            continue;
          }

          // -------------- Overtake detection --------------
          // If both roughly same heading, other is faster by margin, and lateral offset small -> overtaking
          if (hdiff <= 20 && dist <= 12 && speedOther > speedSelf + 1.5) {
            // lateral offset measured as magnitude of component orthogonal to self heading
            const unitAlongX = Math.cos(headingSelfRad), unitAlongY = Math.sin(headingSelfRad);
            const relX = posOther.x - posSelf.x, relY = posOther.y - posSelf.y;
            // lateral = cross-product magnitude = |r x along|
            const lateral = Math.abs(relX * unitAlongY - relY * unitAlongX);
            if (lateral <= OVERTAKE_SIDE_MAX_M) {
              // Require approaching with small TTC to reduce false-positives in slow traffic
              const cpaOver = computeCPA_local(posSelf, velSelf, posOther, velOther, CONFIG.PROJECTION_TIME_SECONDS);
              const vrelX = velOther.x - velSelf.x, vrelY = velOther.y - velSelf.y;
              const rMag2 = relX * relX + relY * relY;
              let closing = 0;
              if (rMag2 > 1e-6) {
                const rMag = Math.sqrt(rMag2);
                closing = - (relX * vrelX + relY * vrelY) / rMag; // positive => approaching
              }
              if (!(closing > 0.3 && cpaOver.tStar <= 2)) {
                // not a strong/near-term overtake; skip
                continue;
              }
              const payloadSelf = {
                type: "overtake",
                sourceVehicle: { userId: other.userId ?? uid, latitude: other.latitude, longitude: other.longitude, speed: speedOther, heading: headingOther },
                distance_m: Number(dist.toFixed(2)),
                lateral_m: Number(lateral.toFixed(2)),
                message: "⚡ Vehicle overtaking from side"
              };
              threats.push(payloadSelf);

              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "overtake",
                  sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                  distance_m: Number(dist.toFixed(2)),
                  lateral_m: Number(lateral.toFixed(2)),
                  message: "⚡ Overtaking detected near vehicle"
                };
                wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
              }
              continue;
            }
          }

          // no threat detected for this other vehicle -> continue
        } catch (innerErr) {
          console.error("❌ Error processing nearby user:", otherIds[i], innerErr);
        }
      } // end for loop otherIds

      // send accumulated threats back to the origin sender (data.userId)
      // format: array of threat objects containing sourceVehicle latitude/longitude & metadata
      ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats }));

    } catch (err) {
      console.error("❌ WebSocket message handling error:", err);
    }
  });

  ws.on("close", () => {
    // cleanup - remove socket from userSockets map
    for (const [uid, socket] of userSockets.entries()) {
      if (socket === ws) {
        userSockets.delete(uid);
        break;
      }
    }
    console.log("❌ WebSocket client disconnected");
  });
});




mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
