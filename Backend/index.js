// server.js
// Full server with prediction-based threat detection.
// This file contains detailed, line-by-line comments inside functions and flow sections.

// -------------------- Imports & Setup --------------------
import express from "express";                    // web framework
import mongoose from "mongoose";                  // MongoDB ORM
import dotenv from "dotenv";                      // loads env vars from .env
import cors from "cors";                          // CORS middleware for express
import router from "./Routes/User.routes.js";     // your existing API routes
import { createServer } from "http";              // Node HTTP server wrapper
import { WebSocketServer } from "ws";             // WebSocket server
import { createClient } from "redis";             // Redis client library

dotenv.config(); // load environment variables from .env into process.env

const app = express(); // create Express app

// -------------------- Express configuration --------------------
// CORS: allows cross-origin requests. If CLIENT_ORIGIN is "*", credentials must be false in browsers.
// We keep your original behavior but be aware that browsers disallow '*' with credentials: true.
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "*",
    credentials: true,
  })
);

// parse JSON payloads up to 50mb
app.use(express.json({ limit: "50mb" }));
// parse urlencoded form data up to 50mb
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// mount your API routes at /api
app.use("/api", router);

// simple health endpoint
app.get("/", (req, res) => {
  console.log("🌐 HTTP GET / - Server is alive");
  res.send("Backend is running 🚀");
});

// simple test endpoint to verify server receives POST bodies
app.post("/api/test", (req, res) => {
  console.log("📨 POST /api/test hit with data:", req.body);
  res.json({ message: "Test route works" });
});

// -------------------- HTTP + WS Server --------------------
const server = createServer(app);                 // wrap express in an HTTP server
const wss = new WebSocketServer({ server });      // attach WebSocket server to HTTP server

// Map userId => WebSocket (single socket per user as original code used)
const userSockets = new Map();

// -------------------- Redis client --------------------
const redisClient = createClient({
  url: process.env.REDIS_URL, // expects REDIS_URL in env
});

// log redis errors to console
redisClient.on("error", (err) => console.error("❌ Redis Error:", err));

// connect to Redis (top-level await used in original code)
await redisClient.connect();
console.log("✅ Connected to Redis");

// -------------------- Utility math & geo helpers --------------------

// getDistanceInMeters: calculates great-circle distance (Haversine) between two {lat,lng} objects
function getDistanceInMeters(loc1, loc2) {
  const R = 6371e3; // Earth radius in meters

  // convert latitudes to radians
  const φ1 = (loc1.lat * Math.PI) / 180;
  const φ2 = (loc2.lat * Math.PI) / 180;

  // difference in radians
  const Δφ = ((loc2.lat - loc1.lat) * Math.PI) / 180;
  const Δλ = ((loc2.lng - loc1.lng) * Math.PI) / 180;

  // Haversine formula components
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // return meters
}

// CONFIG: environment-overridable constants used by detection logic
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

// normalizeHeadingDeg: ensures heading is in [0,360)
function normalizeHeadingDeg(value) {
  // If non-finite input, return 0 as safe default
  if (!Number.isFinite(value)) return 0;
  // take modulo 360 (works for negatives too)
  let h = value % 360;
  if (h < 0) h += 360;
  return h;
}

// clamp: bound a value between min and max
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// projectPoint: forward geodesic projection given (lat, lon), bearing (deg), distance (m)
// returns new { lat, lng } after moving distanceMeters along bearing from original point.
// Uses spherical Earth formula (good accuracy for short distances).
function projectPoint(latDeg, lonDeg, bearingDeg, distanceMeters) {
  const R = 6371e3;                                // Earth radius in meters
  const φ1 = (latDeg * Math.PI) / 180;             // φ1: latitude in radians
  const λ1 = (lonDeg * Math.PI) / 180;             // λ1: longitude in radians
  const θ = (bearingDeg * Math.PI) / 180;          // θ: bearing in radians
  const δ = distanceMeters / R;                    // angular distance

  // precompute trig for performance
  const sinφ1 = Math.sin(φ1);
  const cosφ1 = Math.cos(φ1);
  const sinδ = Math.sin(δ);
  const cosδ = Math.cos(δ);

  // apply spherical forward formula
  const sinφ2 = sinφ1 * cosδ + cosφ1 * sinδ * Math.cos(θ);
  const φ2 = Math.asin(sinφ2);
  const y = Math.sin(θ) * sinδ * cosφ1;
  const x = cosδ - sinφ1 * sinφ2;
  const λ2 = λ1 + Math.atan2(y, x);

  // convert back to degrees
  const lat2 = (φ2 * 180) / Math.PI;
  let lon2 = (λ2 * 180) / Math.PI;

  // normalize lon to [-180, 180]
  if (lon2 > 180) lon2 -= 360;
  if (lon2 < -180) lon2 += 360;
  return { lat: lat2, lng: lon2 };
}

// degreesToMetersVector: approximate local linear conversion of degree delta to meters (east/north)
function degreesToMetersVector(refLatDeg, dLatDeg, dLonDeg) {
  const metersPerDegLat = 111320; // approximate meters per degree lat (constant)
  // meters per degree longitude varies by latitude
  const metersPerDegLon = 111320 * Math.cos((refLatDeg * Math.PI) / 180);
  return {
    x: dLonDeg * metersPerDegLon, // east component (meters)
    y: dLatDeg * metersPerDegLat, // north component (meters)
  };
}

// computeTtcAndCpaMeters: given two motion states (lat,lng,speed,heading),
// compute time-to-closest-approach (TTC), closest point of approach (CPA distance in meters),
// and approximate closing speed. Uses local ENU linearization (works for small separations).
function computeTtcAndCpaMeters(self, other) {
  // self, other: { lat, lng, speed, heading }
  const refLat = self.lat;                         // use self latitude as reference to linearize
  const dLat = other.lat - self.lat;              // delta latitude (degrees)
  const dLon = other.lng - self.lng;              // delta longitude (degrees)
  const r = degreesToMetersVector(refLat, dLat, dLon); // relative position vector (other - self) in meters

  // convert headings to radians
  const toRad = (deg) => (deg * Math.PI) / 180;

  // velocities in local ENU: using speed * [cos(heading), sin(heading)]
  // Note: heading convention must match client (assumed 0° = east? original code assumes standard math axes)
  const vSelf = {
    x: (self.speed ?? 0) * Math.cos(toRad(self.heading ?? 0)),
    y: (self.speed ?? 0) * Math.sin(toRad(self.heading ?? 0)),
  };
  const vOther = {
    x: (other.speed ?? 0) * Math.cos(toRad(other.heading ?? 0)),
    y: (other.speed ?? 0) * Math.sin(toRad(other.heading ?? 0)),
  };

  // relative velocity (other - self)
  const v = { x: vOther.x - vSelf.x, y: vOther.y - vSelf.y };

  // dot product r·v and squared magnitude of v
  const rDotV = r.x * v.x + r.y * v.y;
  const vMag2 = v.x * v.x + v.y * v.y;

  // if relative velocity nearly zero, TTC infinite and CPA is current distance
  if (vMag2 <= 1e-6) {
    return { ttc: Infinity, cpa: Math.hypot(r.x, r.y), closingSpeed: 0 };
  }

  // closing speed ≈ - (r·v) / |r| ; positive means approaching
  const closingSpeed = -rDotV / Math.hypot(r.x, r.y);

  // time to closest approach: - (r·v) / |v|^2
  let ttc = -rDotV / vMag2;
  if (ttc < 0) ttc = Infinity; // if negative, they were closest in the past (diverging now)

  // compute CPA vector at ttc
  const cpaVec = { x: r.x + v.x * ttc, y: r.y + v.y * ttc };
  const cpa = Math.hypot(cpaVec.x, cpaVec.y);
  return { ttc, cpa, closingSpeed };
}

// -------------------- WebSocket Connection Handler (hot path) --------------------
wss.on("connection", (ws) => {
  // When a new WebSocket client connects, we get a 'ws' object for that connection
  console.log("🔗 New WebSocket client connected");

  // Register message handler: invoked whenever this client sends a message
  ws.on("message", async (message) => {
    // Top-level try-catch to prevent a single bad message crashing the handler
    try {
      // Convert message to string safely (could be Buffer)
      const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
      console.log("📥 Incoming WS raw:", raw);

      // Parse JSON payload from client
      const data = JSON.parse(raw);
      console.log("🧾 Parsed:", data);

      // -------------------- Basic validation --------------------
      // ensure userId exists and is a non-empty string
      if (!data || typeof data.userId !== "string" || data.userId.trim() === "") {
        ws.send(JSON.stringify({ status: "error", reason: "missing userId" }));
        return; // drop this message
      }
      // ensure coordinates are numbers
      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        ws.send(JSON.stringify({ status: "error", reason: "invalid coordinates" }));
        return;
      }

      // log validated info for debugging
      console.log("✅ Validated userId", data.userId, "coords", data.latitude, data.longitude, "speed", data.speed, "heading", data.heading);

      // -------------------- Socket registration --------------------
      // Map this user's id to the current WebSocket object so we can push alerts to them later.
      // NOTE: this will overwrite any previous socket for same userId (single-socket-per-user).
      userSockets.set(data.userId, ws);
      console.log("🔗 Registered socket for", data.userId);

      // -------------------- Persist to Redis --------------------
      // Store geo location under Redis GEO key "users" so we can query neighbors by geo
      await redisClient.geoAdd("users", {
        longitude: data.longitude,
        latitude: data.latitude,
        member: data.userId,
      });

      // Store full payload under "userData:{userId}" so we can fetch their speed/heading/timestamp
      // TTL set shorter if speed > 5 m/s (moving quickly), else longer.
      const ttl = data.speed > 5 ? 10 : 30;
      await redisClient.set(`userData:${data.userId}`, JSON.stringify(data), { EX: ttl });
      console.log("🗂️ Redis updated: GEOADD + SET", { member: data.userId, ttl });

      // -------------------- Compute dynamic nearby radius --------------------
      // Use gyro.z to detect sudden turns which increase blind-spot radius.
      // Parse gyro.z safely into a number
      const gyroZRaw = Number(data.gyro?.z ?? 0);
      let gyroZDeg = gyroZRaw;
      // If the device reports in radians (small magnitude), convert to degrees
      if (Math.abs(gyroZRaw) < 0.5) gyroZDeg = gyroZRaw * (180 / Math.PI);
      const isSuddenTurn = Math.abs(gyroZDeg) >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;
      // nearbyRadius increases if sudden turn detected
      const nearbyRadius = CONFIG.NEARBY_RADIUS_METERS + (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);
      console.log("🧭 Gyro.z(deg/s)", Number(gyroZDeg.toFixed?.(2) ?? gyroZDeg), "isSuddenTurn", isSuddenTurn, "nearbyRadius(m)", nearbyRadius);

      // -------------------- Query nearby users --------------------
      // Use Redis GEO radius search to find members near this user
      const nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
      console.log("🔎 Nearby members:", nearbyUserIds);

      // Remove the originating user from the list (we only check others)
      const otherIds = nearbyUserIds.filter(uid => uid !== data.userId);

      // If no nearby vehicles, reply immediately with empty threats
      if (otherIds.length === 0) {
        ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: [] }));
        return;
      }
      console.log("👥 Other IDs:", otherIds);

      // Batch fetch all other vehicles' stored payloads with a single mGet
      const keys = otherIds.map(uid => `userData:${uid}`);
      const usersData = await redisClient.mGet(keys);
      console.log("📦 mGET keys:", keys);

      // -------------------- Helper functions scoped to handler --------------------
      // deg2rad & rad2deg for quick conversions used inside this message handler
      const deg2rad = d => (d * Math.PI) / 180;
      const rad2deg = r => (r * 180) / Math.PI;

      // haversineMeters: returns distance in meters between two lat/lon points
      const haversineMeters = (lat1, lon1, lat2, lon2) => {
        const R = 6371e3; // Earth radius (m)
        const φ1 = deg2rad(lat1), φ2 = deg2rad(lat2);
        const Δφ = deg2rad(lat2 - lat1), Δλ = deg2rad(lon2 - lon1);
        const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };

      // headingDiff: minimal absolute difference between two headings in degrees (0..180)
      const headingDiff = (h1, h2) => {
        let d = Math.abs((h1 ?? 0) - (h2 ?? 0));
        if (d > 180) d = 360 - d;
        return d;
      };

      // computeCPA_local: computes CPA using a local linear approximation in meters
      function computeCPA_local(selfPos, selfVel, otherPos, otherVel, maxT) {
        // r0 = self - other in meters
        const r0x = selfPos.x - otherPos.x;
        const r0y = selfPos.y - otherPos.y;
        // relative velocity (self - other)
        const vx = selfVel.x - otherVel.x;
        const vy = selfVel.y - otherVel.y;
        const vDotV = vx * vx + vy * vy;
        let tStar = 0;
        // if relative speed non-zero compute optimum time, clamp to [0, maxT]
        if (vDotV > 1e-6) {
          tStar = - (r0x * vx + r0y * vy) / vDotV;
          tStar = Math.max(0, Math.min(maxT, tStar));
        }
        // positions at tStar
        const aPosX = selfPos.x + selfVel.x * tStar;
        const aPosY = selfPos.y + selfVel.y * tStar;
        const bPosX = otherPos.x + otherVel.x * tStar;
        const bPosY = otherPos.y + otherVel.y * tStar;
        const dist = Math.hypot(aPosX - bPosX, aPosY - bPosY);
        return { tStar, dist, selfAtT: { x: aPosX, y: aPosY }, otherAtT: { x: bPosX, y: bPosY } };
      }

      // -------------------- Convert incoming self into local frame --------------------
      // Use incoming device as origin in a local ENU frame where north = x, east = y
      const baseLat = data.latitude;
      const baseLon = data.longitude;

      // approximations for converting lat/lon deltas to meters in this local frame
      const metersPerDegLat = 111320;
      const metersPerDegLonBase = Math.cos(deg2rad(baseLat)) * 111320;

      // normalize heading and compute velocity vector (x,y) in meters/second
      const headingSelf = normalizeHeadingDeg(Number(data.heading ?? 0));
      const headingSelfRad = deg2rad(headingSelf);
      const speedSelf = Math.max(0, Number(data.speed ?? 0));
      const velSelf = { x: speedSelf * Math.cos(headingSelfRad), y: speedSelf * Math.sin(headingSelfRad) };

      // self at origin in local coordinates
      const posSelf = { x: 0, y: 0 };
      console.log("🚗 Self:", { headingSelf, speedSelf, velSelf, posSelf });

      const now = Date.now();   // server receive time used for staleness checks
      const threats = [];       // accumulate threat objects to return to sender

      // local thresholds used for detection
      const MIN_SPEED_FOR_INTERSECTION = 2.78; // 10 km/h in m/s
      const INTERSECTION_DIST_M = 8;
      const REAR_TTC_THRESH = CONFIG.TTC_MAX_SECONDS ?? 3;
      const REAR_CLOSING_SPEED_MIN = 0.5; // m/s
      const OVERTAKE_SIDE_MAX_M = 4;
      const WRONG_DIR_RADIUS_M = 30;

      // -------------------- NEW PREDICTION-BASED DETECTION CONFIG --------------------
      // Tweak these values to trade sensitivity vs false positives
      const LOOKAHEAD_S = 5;            // how many seconds into future to predict
      const PREDICT_STEP = 1;           // prediction timestep in seconds
      const COLLISION_RADIUS = 4;       // distance (meters) to consider predictions overlapping (collision)
      const REAR_END_DISTANCE = 10;     // meters threshold for close following
      const SUDDEN_DECEL = 2.0;         // m/s^2 threshold to classify sudden braking
      const WRONG_DIR_DIFF = 150;       // heading diff threshold for wrong-direction detection

      // -------------------- Speed history (in-memory) --------------------
      // Keep a sliding window of latest speed samples for each user in global.speedHistory.
      // This is used to detect sudden deceleration on other vehicles.
      if (!global.speedHistory) global.speedHistory = {};
      if (!global.speedHistory[data.userId]) global.speedHistory[data.userId] = [];
      // push this user's current speed sample
      global.speedHistory[data.userId].push({ speed: speedSelf, t: now });
      // keep last 5 samples per user to limit memory
      global.speedHistory[data.userId] = global.speedHistory[data.userId].slice(-5);

      // predictPosition: simple straight-line constant-speed+heading projection
      function predictPosition(lat, lon, heading, speed, t) {
        // distance traveled = speed (m/s) * t (s)
        const dist = speed * t;
        // return geodesic-projected lat/lon after moving dist along heading
        return projectPoint(lat, lon, heading, dist);
      }

      // majority-heading calculation: collect headings of all nearby + self
      // This is used to detect a vehicle going opposite to majority (wrong-direction in single-lane)
      let allHeadings = [headingSelf];
      for (let i = 0; i < otherIds.length; i++) {
        const raw = usersData[i];
        if (!raw) continue;
        try {
          const otherTmp = JSON.parse(raw);
          allHeadings.push(normalizeHeadingDeg(Number(otherTmp.heading ?? 0)));
        } catch (e) {
          // skip malformed payloads silently
        }
      }

      // avgHeading: compute vector-mean of headings to avoid wraparound issues (0/360)
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

      // compute a single "majority direction" normalized to [0,360)
      const majorityDirection = normalizeHeadingDeg(avgHeading(allHeadings));

      // -------------------- MAIN: check each nearby vehicle --------------------
      // We iterate through otherIds (neighbors returned from Redis GEO radius)
      for (let i = 0; i < otherIds.length; i++) {
        try {
          const uid = otherIds[i];                 // neighbor's userId
          const raw = usersData[i];                // string from Redis mGet
          if (!raw) continue;                      // skip if no payload
          const other = JSON.parse(raw);           // parse neighbor JSON payload

          // staleness check: skip if neighbor's timestamp too old or invalid
          const otherTs = new Date(other.timestamp || 0).getTime();
          if (!Number.isFinite(otherTs) || now - otherTs > CONFIG.STALE_MS) {
            console.log("⏳ Skip stale", uid, "age(ms)", Number.isFinite(otherTs) ? (now - otherTs) : "invalid");
            continue;
          }

          // normalize neighbor heading and speed
          const headingOther = normalizeHeadingDeg(Number(other.heading ?? 0));
          const speedOther = Math.max(0, Number(other.speed ?? 0));

          // current distance between self and other (haversine for accuracy)
          const distNow = haversineMeters(baseLat, baseLon, other.latitude, other.longitude);
          const hdiff = headingDiff(headingSelf, headingOther);

          // ---------- 1) PREDICTED COLLISION CHECK ----------
          // We predict into the future for both vehicles (1..LOOKAHEAD_S seconds)
          // using constant speed & heading, and check if their predicted positions
          // are within COLLISION_RADIUS at the same prediction timestep.
          let collisionDetected = false;

          // loop t = 1,2,...,LOOKAHEAD_S
          for (let t = PREDICT_STEP; t <= LOOKAHEAD_S; t += PREDICT_STEP) {
            // predict self's lat/lon after t seconds
            const selfPred = predictPosition(data.latitude, data.longitude, headingSelf, speedSelf, t);
            // predict other's lat/lon after t seconds
            const otherPred = predictPosition(other.latitude, other.longitude, headingOther, speedOther, t);

            // compute distance between predicted positions
            const dPred = haversineMeters(selfPred.lat, selfPred.lng, otherPred.lat, otherPred.lng);

            // if predicted distance <= collision threshold, declare predicted collision
            if (dPred <= COLLISION_RADIUS) {
              const payloadSelf = {
                type: "predicted_collision",
                sourceVehicle: { userId: other.userId ?? uid, latitude: other.latitude, longitude: other.longitude, speed: speedOther, heading: headingOther },
                future_distance_m: Number(dPred.toFixed(2)),
                time_s: t,
                message: "⚠️ Predicted collision based on future paths"
              };
              // push threat to array to return to the origin sender
              threats.push(payloadSelf);

              // also notify the other vehicle immediately if they have a WebSocket
              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "predicted_collision",
                  sourceVehicle: { userId: data.userId, latitude: data.latitude, longitude: data.longitude, speed: speedSelf, heading: headingSelf },
                  future_distance_m: Number(dPred.toFixed(2)),
                  time_s: t,
                  message: "⚠️ Predicted collision based on future paths"
                };
                try { wsOther.send(JSON.stringify({ status: "threat", data: payloadOther })); } catch(_) {}
              }

              // mark collision detected and break out of prediction loop
              collisionDetected = true;
              break;
            }
          }

          // if collision found, skip other checks for this neighbor (we already notified)
          if (collisionDetected) continue;

          // ---------- 2) REAR-END COLLISION (sudden braking detection) ----------
          // We maintain in-memory speed history to detect sudden deceleration
          // of other vehicles. If the 'other' suddenly slows and self is close
          // and closing, we flag a rear-end threat.
          const otherHist = global.speedHistory[other.userId] ?? [];
          if (otherHist.length >= 2) {
            const last = otherHist[otherHist.length - 1];   // newest sample for other (if it exists)
            const prev = otherHist[otherHist.length - 2];   // previous sample
            const dt = (last.t - prev.t) / 1000 || 1;       // delta seconds (fallback 1 to avoid div by zero)

            // deceleration estimated as previous speed - last speed over dt
            // positive value means speed dropped (deceleration)
            const decel = (prev.speed - last.speed) / dt;

            const relativeDist = distNow;
            // closingSpeed = speedSelf - speedOther (positive means self catching up)
            const closingSpeed = speedSelf - speedOther;

            // Criteria:
            //  - other (front) decelerated >= SUDDEN_DECEL
            //  - distance <= REAR_END_DISTANCE
            //  - follower (self) closing speed > 0.5 m/s
            if (decel >= SUDDEN_DECEL && relativeDist <= REAR_END_DISTANCE && closingSpeed > 0.5) {
              const payloadSelf = {
                type: "rear_end",
                sourceVehicle: { userId: other.userId ?? uid, speed: speedOther, heading: headingOther },
                distance_m: Number(relativeDist.toFixed(2)),
                deceleration: Number(decel.toFixed(2)),
                message: "🚨 Rear-end danger! Front vehicle is braking hard"
              };
              threats.push(payloadSelf);

              // notify the other vehicle (front) they may be about to be hit
              const wsOther = userSockets.get(uid);
              if (wsOther && wsOther.readyState === wsOther.OPEN) {
                const payloadOther = {
                  type: "rear_end",
                  sourceVehicle: { userId: data.userId, speed: speedSelf, heading: headingSelf },
                  distance_m: Number(relativeDist.toFixed(2)),
                  deceleration: Number(decel.toFixed(2)),
                  message: "🚨 Vehicle behind may hit you"
                };
                try { wsOther.send(JSON.stringify({ status: "threat", data: payloadOther })); } catch(_) {}
              }

              // done for this neighbor (we've warned)
              continue;
            }
          }

          // ---------- 3) WRONG-DIRECTION DETECTION (majority heading approach) ----------
          // If a neighbor's heading deviates significantly from the majority direction
          // of vehicles within the cluster, and they are close, treat them as wrong-direction.
          const headingDifferenceFromMajority = headingDiff(headingOther, majorityDirection);

          if (headingDifferenceFromMajority >= WRONG_DIR_DIFF && distNow <= 40) {
            const payloadSelf = {
              type: "wrong_direction",
              sourceVehicle: { userId: other.userId ?? uid, heading: headingOther },
              distance_m: Number(distNow.toFixed(2)),
              message: "🚫 Vehicle traveling in opposite direction"
            };
            threats.push(payloadSelf);

            const wsOther = userSockets.get(uid);
            if (wsOther && wsOther.readyState === wsOther.OPEN) {
              const payloadOther = {
                type: "wrong_direction",
                sourceVehicle: { userId: data.userId, heading: headingSelf },
                distance_m: Number(distNow.toFixed(2)),
                message: "🚫 You are going opposite to traffic"
              };
              try { wsOther.send(JSON.stringify({ status: "threat", data: payloadOther })); } catch(_) {}
            }
            continue;
          }

          // ---------- Optional: Reintroduce intersection & overtake checks ----------
          // You previously had logic to detect intersections and overtakes using CPA/TTC/local projections.
          // We intentionally prioritized the requested prediction + rear-end + wrong-direction checks.
          // If you want to combine both, you can re-add those blocks here (they were in your original code).

        } catch (innerErr) {
          // catch errors per neighbor to avoid whole loop crashing for a malformed neighbor
          console.error("❌ Error processing nearby user:", otherIds[i], innerErr);
        }
      } // end for loop otherIds

      // after processing all neighbors, send accumulated threats back to the sender
      console.log("📤 Sender threats count", threats.length);
      ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats }));

    } catch (err) {
      // catch JSON.parse or unexpected errors from the incoming message
      console.error("❌ WebSocket message handling error:", err);
    }
  }); // end ws.on("message")

  // -------------------- Handle socket close --------------------
  ws.on("close", () => {
    // Remove any userSockets entries that point to this ws instance
    for (const [uid, socket] of userSockets.entries()) {
      if (socket === ws) {
        userSockets.delete(uid); // remove mapping
        break;
      }
    }
    console.log("❌ WebSocket client disconnected");
  });
}); // end wss.on("connection")

// -------------------- MongoDB connect & start HTTP server --------------------
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ MongoDB connected");

    const PORT = process.env.PORT || 5000;
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error("❌ MongoDB connection error:", err));
