// server.js
import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import router from "./Routes/User.routes.js";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import Road from "./Models/Road.Model.js";

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

app.get("/api/nearby-roads", async (req, res) => {
  try {
    const { lat, lon, radius } = req.query;
    const latNum = parseFloat(lat);
    const lonNum = parseFloat(lon);
    const radiusNum = parseInt(radius || "60", 10);

    if (isNaN(latNum) || isNaN(lonNum)) {
      return res.status(400).json({ error: "Invalid lat/lon" });
    }

    const roads = await Road.find({
      geometry: {
        $near: {
          $geometry: { type: "Point", coordinates: [lonNum, latNum] },
          $maxDistance: radiusNum,
        },
      },
    }).limit(30).lean();

    const elements = roads.map((r) => ({
      type: "way",
      id: r.osmId,
      nodes: [],
      tags: {
        highway: r.highway,
        name: r.name || undefined,
        oneway: r.oneway || undefined,
      },
      geometry: r.geometry.coordinates.map((c) => ({
        lat: c[1],
        lon: c[0],
      })),
    }));

    console.log(`🗺️ nearby-roads: ${elements.length} roads near ${latNum},${lonNum}`);
    res.json({ elements });
  } catch (err) {
    console.error("❌ nearby-roads error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Map userId => WebSocket
const userSockets = new Map();

// Redis client
const redisClient = createClient({
  url: process.env.REDIS_URL,
});
redisClient.on("error", (err) => console.error("❌ Redis Error:", err));

await redisClient.connect();
console.log("✅ Connected to Redis");

// --- Utility helpers ---
function getDistanceInMeters(loc1, loc2) {
  const R = 6371e3;
  const φ1 = (loc1.lat * Math.PI) / 180;
  const φ2 = (loc2.lat * Math.PI) / 180;
  const Δφ = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const Δλ = ((loc2.lng - loc1.lng) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

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

// Minimum speed (m/s) required to run predicted-collision logic (5 km/h = 1.388... m/s)
const MIN_PREDICT_COLLISION_SPEED = 1.38; // 5 km/h in m/s

function normalizeHeadingDeg(value) {
  if (!Number.isFinite(value)) return 0;
  let h = value % 360;
  if (h < 0) h += 360;
  return h;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

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

function degreesToMetersVector(refLatDeg, dLatDeg, dLonDeg) {
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((refLatDeg * Math.PI) / 180);
  return {
    x: dLonDeg * metersPerDegLon,
    y: dLatDeg * metersPerDegLat,
  };
}

function computeTtcAndCpaMeters(self, other) {
  const refLat = self.lat;
  const dLat = other.lat - self.lat;
  const dLon = other.lng - self.lng;
  const r = degreesToMetersVector(refLat, dLat, dLon);

  const toRad = (deg) => (deg * Math.PI) / 180;
  const vSelf = {
    x: (self.speed ?? 0) * Math.cos(toRad(self.heading ?? 0)),
    y: (self.speed ?? 0) * Math.sin(toRad(self.heading ?? 0)),
  };
  const vOther = {
    x: (other.speed ?? 0) * Math.cos(toRad(other.heading ?? 0)),
    y: (other.speed ?? 0) * Math.sin(toRad(other.heading ?? 0)),
  };
  const v = { x: vOther.x - vSelf.x, y: vOther.y - vSelf.y };

  const rDotV = r.x * v.x + r.y * v.y;
  const vMag2 = v.x * v.x + v.y * v.y;
  if (vMag2 <= 1e-6) {
    return { ttc: Infinity, cpa: Math.hypot(r.x, r.y), closingSpeed: 0 };
  }
  const closingSpeed = -rDotV / Math.hypot(r.x, r.y);
  let ttc = -rDotV / vMag2;
  if (ttc < 0) ttc = Infinity;
  const cpaVec = { x: r.x + v.x * ttc, y: r.y + v.y * ttc };
  const cpa = Math.hypot(cpaVec.x, cpaVec.y);
  return { ttc, cpa, closingSpeed };
}

// ---------------- WebSocket connection ----------------
wss.on("connection", (ws) => {
  console.log("🔗 New WebSocket client connected");

  ws.on("message", async (message) => {
    try {
      const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
      console.log("📥 Incoming WS raw:", raw);

      const data = JSON.parse(raw);
      console.log("🧾 Parsed:", data);

      // Basic validation
      if (!data || typeof data.userId !== "string" || data.userId.trim() === "") {
        console.log("⚠️ validation failed: missing userId");
        ws.send(JSON.stringify({ status: "error", reason: "missing userId" }));
        return;
      }
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        console.log("⚠️ validation failed: invalid coordinates");
        ws.send(JSON.stringify({ status: "error", reason: "invalid coordinates" }));
        return;
      }

      console.log(`ℹ️ Processing update for userId=${data.userId}`);

      // Register socket
      userSockets.set(data.userId, ws);
      console.log(`🔗 userSockets set for ${data.userId}`);

      // Persist geo to Redis (GEOADD)
      try {
        await redisClient.geoAdd("users", {
          longitude: data.longitude,
          latitude: data.latitude,
          member: data.userId,
        });
        console.log(`🗺️ GEOADD users ${data.userId} @ ${data.latitude},${data.longitude}`);
      } catch (e) {
        console.error("❌ Redis GEOADD failed:", e);
      }

      // Persist full payload
      const ttl = data.speed > 5 ? 10 : 30;
      try {
        await redisClient.set(`userData:${data.userId}`, JSON.stringify(data), { EX: ttl });
        console.log(`💾 SET userData:${data.userId} (ttl=${ttl}s)`);
      } catch (e) {
        console.error("❌ Redis SET userData failed:", e);
      }

      // Gyro check -> dynamic radius
      const gyroZRaw = Number(data.gyro?.z ?? 0);
      let gyroZDeg = gyroZRaw;
      if (Math.abs(gyroZRaw) < 0.5) gyroZDeg = gyroZRaw * (180 / Math.PI);
      const isSuddenTurn = Math.abs(gyroZDeg) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;
      const nearbyRadius = CONFIG.NEARBY_RADIUS_METERS + (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);
      console.log(`🧭 gyroZ(deg/s)=${gyroZDeg.toFixed(3)} suddenTurn=${isSuddenTurn} nearbyRadius=${nearbyRadius}m`);

      // Fetch nearby
      let nearbyUserIds = [];
      try {
        nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
        console.log(`🔎 geoRadiusByMember found ${nearbyUserIds.length} members`);
      } catch (e) {
        console.error("❌ Redis geoRadiusByMember failed:", e);
      }

      const otherIds = nearbyUserIds.filter(uid => uid !== data.userId);
      console.log(`👥 otherIds (excluding self): ${otherIds.length}`, otherIds);

      if (otherIds.length === 0) {
        ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: [] }));
        console.log("📤 No neighbors -> returning empty threats");
        return;
      }

      const keys = otherIds.map(uid => `userData:${uid}`);
      let usersData = [];
      try {
        usersData = await redisClient.mGet(keys);
        console.log(`📦 mGet returned ${usersData.length} entries`);
      } catch (e) {
        console.error("❌ Redis mGet failed:", e);
      }

      // local helper functions
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

      // ENU local frame for self
      const baseLat = data.latitude;
      const baseLon = data.longitude;
      const metersPerDegLat = 111320;
      const metersPerDegLonBase = Math.cos(deg2rad(baseLat)) * 111320;

      const headingSelf = normalizeHeadingDeg(Number(data.heading ?? 0));
      const headingSelfRad = deg2rad(headingSelf);
      const speedSelf = Math.max(0, Number(data.speed ?? 0));
      const velSelf = { x: speedSelf * Math.cos(headingSelfRad), y: speedSelf * Math.sin(headingSelfRad) };
      const posSelf = { x: 0, y: 0 };
      console.log(`🚗 Self id=${data.userId} lat=${baseLat} lon=${baseLon} speed=${speedSelf} heading=${headingSelf}`);

      const now = Date.now();
      const threats = [];

      // detection config
      const LOOKAHEAD_S = 5;
      const PREDICT_STEP = 1;
      const COLLISION_RADIUS = 4;
      const REAR_END_DISTANCE = 10;
      const SUDDEN_DECEL = 2.0;
      const WRONG_DIR_DIFF = 150;

      // maintain short in-memory speed history for self
      if (!global.speedHistory) global.speedHistory = {};
      if (!global.speedHistory[data.userId]) global.speedHistory[data.userId] = [];
      global.speedHistory[data.userId].push({ speed: speedSelf, t: now });
      global.speedHistory[data.userId] = global.speedHistory[data.userId].slice(-5);

      function predictPosition(lat, lon, heading, speed, t) {
        const dist = speed * t;
        return projectPoint(lat, lon, heading, dist);
      }

      // majority heading
      let allHeadings = [headingSelf];
      for (let i = 0; i < otherIds.length; i++) {
        const raw = usersData[i];
        if (!raw) continue;
        try {
          const otherTmp = JSON.parse(raw);
          allHeadings.push(normalizeHeadingDeg(Number(otherTmp.heading ?? 0)));
        } catch (e) {
          console.log(`⚠️ malformed usersData[${i}] for ${otherIds[i]}`);
        }
      }
      function avgHeading(arr) {
        let x = 0, y = 0;
        for (let h of arr) {
          const rad = (h * Math.PI) / 180;
          x += Math.cos(rad);
          y += Math.sin(rad);
        }
        if (x === 0 && y === 0) return 0;
        return (Math.atan2(y, x) * 180) / Math.PI;
      }
      const majorityDirection = normalizeHeadingDeg(avgHeading(allHeadings));
      console.log(`📐 majorityDirection=${majorityDirection} based on ${allHeadings.length} vehicles`);

      // MAIN loop: check each nearby vehicle
      for (let i = 0; i < otherIds.length; i++) {
        try {
          const uid = otherIds[i];
          const raw = usersData[i];
          if (!raw) {
            console.log(`⚠️ skipping ${uid} because userData missing`);
            continue;
          }
          const other = JSON.parse(raw);

          const otherTs = new Date(other.timestamp || 0).getTime();
          if (!Number.isFinite(otherTs) || now - otherTs > CONFIG.STALE_MS) {
            console.log(`⏳ skipping ${uid} because stale: ageMs=${Number.isFinite(otherTs) ? (now - otherTs) : "invalid"}`);
            continue;
          }

          const headingOther = normalizeHeadingDeg(Number(other.heading ?? 0));
          const speedOther = Math.max(0, Number(other.speed ?? 0));

          const distNow = haversineMeters(baseLat, baseLon, other.latitude, other.longitude);
          const hdiff = headingDiff(headingSelf, headingOther);

          // LOG distance & heading diff
          console.log(`📏 [${data.userId} ↔ ${uid}] distNow=${distNow.toFixed(2)}m headingDiff=${hdiff}° speedSelf=${speedSelf} speedOther=${speedOther}`);
        // ----------------------------------------------------
// TURN COLLISION DETECTION (NEW)
// ----------------------------------------------------
try {
  const selfTurn = data.turnAhead === true;
  const otherTurn = other.turnAhead === true;

  // Only run if both vehicles detected a turn AND speeds > 5 km/h
  if (
    selfTurn &&
    otherTurn &&
    data.intersectionLat != null &&
    other.intersectionLat != null &&
    speedSelf > MIN_PREDICT_COLLISION_SPEED &&
    speedOther > MIN_PREDICT_COLLISION_SPEED
  ) {
    const turnA = {
      lat: data.intersectionLat,
      lng: data.intersectionLng,
    };

    const turnB = {
      lat: other.intersectionLat,
      lng: other.intersectionLng,
    };

    // 1) Check if both vehicles have the SAME turn (within ~8 meters)
    const turnDist = haversineMeters(
      turnA.lat, turnA.lng,
      turnB.lat, turnB.lng
    );

    if (turnDist <= 8) {
      // Distance from each vehicle to the turn
      const distSelfToTurn = haversineMeters(
        baseLat, baseLon,
        turnA.lat, turnA.lng
      );

      const distOtherToTurn = haversineMeters(
        other.latitude, other.longitude,
        turnA.lat, turnA.lng
      );

      // Time (seconds) to reach the turn
      const etaSelf = distSelfToTurn / (speedSelf + 0.1);
      const etaOther = distOtherToTurn / (speedOther + 0.1);
      console.log("TURN DATA RECEIVED:", data.intersectionLat, data.intersectionLng)
console.log("TURN MATCH DISTANCE:", turnDist)
console.log("TURN ETA SELF:", etaSelf)
console.log("TURN ETA OTHER:", etaOther)

      // Collision risk if both reach within 2 seconds window
      if (Math.abs(etaSelf - etaOther) <= 2.0) {
        const payloadSelf = {
          type: "turn_collision",
          id: other.userId ?? uid,
          lat: other.latitude,
          lng: other.longitude,
          intersectionLat: turnA.lat,
          intersectionLng: turnA.lng,
          message: "⚠️ Collision risk at turn ahead",
        };

        threats.push(payloadSelf);
        console.log("🚨 TURN COLLISION THREAT (SELF):", payloadSelf);

        // Notify other vehicle
        const wsOther = userSockets.get(uid);
        if (wsOther && wsOther.readyState === wsOther.OPEN) {
          const payloadOther = {
            type: "turn_collision",
            id: data.userId,
            lat: data.latitude,
            lng: data.longitude,
            intersectionLat: turnA.lat,
            intersectionLng: turnA.lng,
            message: "⚠️ Collision risk at turn ahead",
          };

          wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
          console.log("📣 Sent TURN COLLISION to:", uid);
        }
      }
    }
  }
} catch (e) {
  console.error("❌ Turn collision logic error:", e);
}
// ----------------------------------------------------


          // 🔒 Only detect predicted collision when at least one vehicle is above 5 km/h
          if (speedSelf < MIN_PREDICT_COLLISION_SPEED && speedOther < MIN_PREDICT_COLLISION_SPEED) {
            console.log(`⛔ Skipping predicted collision: both too slow (<5km/h).`);
            // Continue to next vehicle, skipping predicted collision
            continue;
          }

          // 1) Predicted collision check
          let collisionDetected = false;
          for (let t = PREDICT_STEP; t <= LOOKAHEAD_S; t += PREDICT_STEP) {
            const selfPred = predictPosition(data.latitude, data.longitude, headingSelf, speedSelf, t);
            const otherPred = predictPosition(other.latitude, other.longitude, headingOther, speedOther, t);
            const dPred = haversineMeters(selfPred.lat, selfPred.lng, otherPred.lat, otherPred.lng);
            console.log(`🔮 predict t=${t}s for ${data.userId} vs ${uid} -> predictedDist=${dPred.toFixed(2)}m`);
            if (dPred <= COLLISION_RADIUS) {
              const payloadSelf = {
                type: "predicted_collision",
                id: other.userId ?? uid,                // ⭐ REQUIRED BY FLUTTER
                lat: other.latitude,                    // ⭐ REQUIRED BY FLUTTER
                lng: other.longitude,                   // ⭐ REQUIRED BY FLUTTER
            
                // original metadata preserved
                sourceVehicle: {
                    userId: other.userId ?? uid,
                    latitude: other.latitude,
                    longitude: other.longitude,
                    speed: speedOther,
                    heading: headingOther
                },
                future_distance_m: Number(dPred.toFixed(2)),
                time_s: t,
                message: "⚠️ Predicted collision based on future paths"
            };
            
              console.log("🚨 PREDICTED COLLISION detected:", payloadSelf);
              threats.push(payloadSelf);

              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "predicted_collision",
                  id: data.userId,
                  lat: data.latitude,
                  lng: data.longitude,
              
                  sourceVehicle: {
                      userId: data.userId,
                      latitude: data.latitude,
                      longitude: data.longitude,
                      speed: speedSelf,
                      heading: headingSelf
                  },
                  future_distance_m: Number(dPred.toFixed(2)),
                  time_s: t,
                  message: "⚠️ Predicted collision based on future paths"
              };
              
                try {
                  wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                  console.log(`📣 Sent predicted_collision to other ${uid}`);
                } catch (e) {
                  console.error(`❌ Failed to send predicted_collision to ${uid}:`, e);
                }
              }

              collisionDetected = true;
              break;
            }
          }
          if (collisionDetected) continue;

          // 2) Rear-end detection: use other user's speed history
          const otherHist = global.speedHistory[other.userId] ?? [];
          if (otherHist.length >= 2) {
            const last = otherHist[otherHist.length - 1];
            const prev = otherHist[otherHist.length - 2];
            const dt = (last.t - prev.t) / 1000 || 1;
            const decel = (prev.speed - last.speed) / dt;
            const relativeDist = distNow;
            const closingSpeed = speedSelf - speedOther;
            console.log(`🛑 Rear-check ${uid}: decel=${decel.toFixed(2)}m/s² closingSpeed=${closingSpeed.toFixed(2)}m/s relativeDist=${relativeDist.toFixed(2)}m`);
            if (decel >= SUDDEN_DECEL && relativeDist <= REAR_END_DISTANCE && closingSpeed > 0.5) {
              const payloadSelf = {
                type: "rear_end",
                id: other.userId ?? uid,
                lat: other.latitude,
                lng: other.longitude,
            
                sourceVehicle: {
                    userId: other.userId ?? uid,
                    latitude: other.latitude,
                    longitude: other.longitude,
                    speed: speedOther,
                    heading: headingOther
                },
                distance_m: Number(relativeDist.toFixed(2)),
                deceleration: Number(decel.toFixed(2)),
                message: "🚨 Rear-end danger! Front vehicle is braking hard"
            };
            
              console.log("🚨 REAR-END threat:", payloadSelf);
              threats.push(payloadSelf);

              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "rear_end",
                  id: data.userId,
                  lat: data.latitude,
                  lng: data.longitude,
              
                  sourceVehicle: {
                      userId: data.userId,
                      latitude: data.latitude,
                      longitude: data.longitude,
                      speed: speedSelf,
                      heading: headingSelf
                  },
                  distance_m: Number(relativeDist.toFixed(2)),
                  deceleration: Number(decel.toFixed(2)),
                  message: "🚨 Vehicle behind may hit you"
              };
              
                try {
                  wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                  console.log(`📣 Sent rear_end to other ${uid}`);
                } catch (e) {
                  console.error(`❌ Failed to send rear_end to ${uid}:`, e);
                }
              }
              continue;
            }
          } else {
            console.log(`ℹ️ No sufficient speedHistory for ${uid} (len=${otherHist.length})`);
          }

          // 3) Wrong-direction detection using majority heading
          const headingDifferenceFromMajority = headingDiff(headingOther, majorityDirection);
          console.log(`↔️ Wrong-direction check ${uid}: diffFromMajority=${headingDifferenceFromMajority}° (threshold=${WRONG_DIR_DIFF})`);
          if (headingDifferenceFromMajority >= WRONG_DIR_DIFF && distNow <= 40) {
            const payloadSelf = {
              type: "wrong_direction",
              id: other.userId ?? uid,
              lat: other.latitude,
              lng: other.longitude,
          
              sourceVehicle: {
                  userId: other.userId ?? uid,
                  latitude: other.latitude,
                  longitude: other.longitude,
                  heading: headingOther
              },
              distance_m: Number(distNow.toFixed(2)),
              message: "🚫 Vehicle traveling in opposite direction"
          };
          
            console.log("🚨 WRONG DIRECTION threat:", payloadSelf);
            threats.push(payloadSelf);

            const wsOther = userSockets.get(uid);
            if (wsOther && wsOther.readyState === wsOther.OPEN) {
              const payloadOther = {
                type: "wrong_direction",
                id: data.userId,
                lat: data.latitude,
                lng: data.longitude,
            
                sourceVehicle: {
                    userId: data.userId,
                    latitude: data.latitude,
                    longitude: data.longitude,
                    heading: headingSelf
                },
                distance_m: Number(distNow.toFixed(2)),
                message: "🚫 You are going opposite to traffic"
            };
            
              try {
                wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                console.log(`📣 Sent wrong_direction to other ${uid}`);
              } catch (e) {
                console.error(`❌ Failed to send wrong_direction to ${uid}:`, e);
              }
            }
            continue;
          }

          // If reached here, no threat for this neighbor
          console.log(`✅ No threat detected for neighbor ${uid}`);
        } catch (innerErr) {
          console.error("❌ Error processing nearby user:", otherIds[i], innerErr);
        }
      } // end for otherIds

      // send threats back to origin
      console.log(`📤 Finished checks. Returning ${threats.length} threat(s) to ${data.userId}`);
      try {
        ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats }));
      } catch (e) {
        console.error("❌ Failed to send response to origin:", e);
      }

    } catch (err) {
      console.error("❌ WebSocket message handling error:", err);
    }
  });

  ws.on("close", () => {
    for (const [uid, socket] of userSockets.entries()) {
      if (socket === ws) {
        userSockets.delete(uid);
        console.log(`🔌 Removed socket mapping for ${uid}`);
        break;
      }
    }
    console.log("❌ WebSocket client disconnected");
  });
}); // end wss.on("connection")

// Start Mongo + server
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
