// server.js
import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import cors from "cors";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import router from "./Routes/User.routes.js";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { createClient } from "redis";
import { createHash } from "crypto";
import Road from "./Models/Road.Model.js";
import Turn from "./Models/Turn.Model.js";
import TurningEvent from "./Models/TurningEvent.Model.js";
import RoadGraph from "./roadGraph.js";
import MapMatcher from "./mapMatcher.js";
import EtaRegistry from "./etaRegistry.js";
import { computePredictionUncertainty, computeOverlapProbability, classifyStaleness, classifyAlert, computeAlertConfidence } from "./degradation.js";

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

// Rate limiting
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Too many login attempts, try again after 15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many registration attempts, try again after an hour" },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Too many requests, slow down" },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/Login", loginLimiter);
app.use("/api/register", registerLimiter);
app.use("/api/", apiLimiter);

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
      nodes: r.nodes || [],
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
// Reverse map socket => userId for O(1) close cleanup
const socketToUser = new Map();

// Nearby user cache to reduce Redis queries
// Key: userId, Value: { nearbyIds, timestamp, lat, lng }
const nearbyCache = new Map();
const NEARBY_CACHE_TTL_MS = 2000;
const NEARBY_CACHE_MOVE_THRESHOLD_M = 10;

// One-way road cache (userId => last known oneway context)
const onewayCache = new Map();

// Sprint 1: Road graph, map matcher, ETA registry
let roadGraph = null;
let mapMatcher = null;
let etaRegistry = null;

// Road vehicle map: roadId → Set<userId>
const roadVehicleMap = new Map();

// Previous road map for continuity scoring
const previousRoadMap = new Map();

// Time sync tracking: userId → { offset, jitter, confidence }
const timeSyncMap = new Map();

// Tracking stale/expired vehicles
const vehicleLastSeen = new Map();

// Risk score tracking per junction (in-memory, resets on restart)
// Key: "lat,lng" rounded to 4 decimals, Value: { nearMisses, brakeEvents, totalThreats }
const junctionRisk = new Map();

function getJunctionKey(lat, lng) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

function updateJunctionRisk(lat, lng) {
  const key = getJunctionKey(lat, lng);
  const entry = junctionRisk.get(key) || { nearMisses: 0, brakeEvents: 0, totalThreats: 0 };
  entry.totalThreats++;
  junctionRisk.set(key, entry);
}

function getJunctionRiskScore(lat, lng) {
  const key = getJunctionKey(lat, lng);
  const entry = junctionRisk.get(key);
  if (!entry) return 1;
  // Score 1-10 based on history
  const score = Math.min(10, 1 + Math.floor((entry.totalThreats + entry.brakeEvents * 2) / 3));
  return score;
}

// Redis client with graceful error handling
// FIX BUG #4: Redis connection failure handled gracefully - server doesn't crash
let redisClient = null;
let redisConnected = false;

async function initRedis() {
  if (!process.env.REDIS_URL) {
    console.warn("⚠️ REDIS_URL not set, running without Redis (limited functionality)");
    return;
  }
  try {
    redisClient = createClient({ url: process.env.REDIS_URL });
    redisClient.on("error", (err) => {
      console.error("❌ Redis Error:", err.message);
      redisConnected = false;
    });
    redisClient.on("ready", () => {
      console.log("✅ Connected to Redis");
      redisConnected = true;
    });
    redisClient.on("end", () => {
      console.warn("⚠️ Redis connection ended");
      redisConnected = false;
    });
    await redisClient.connect();
  } catch (err) {
    console.warn("⚠️ Redis connection failed, running without Redis:", err.message);
    redisConnected = false;
  }
}

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
  STALE_MS: Number(process.env.STALE_MS ?? 8000),
  TTC_MAX_SECONDS: Number(process.env.TTC_MAX_SECONDS ?? 3),
  CLOSING_SPEED_STRONG_MS: Number(process.env.CLOSING_SPEED_STRONG_MS ?? 10),
};

// Minimum speed (m/s) required to run predicted-collision logic (5 km/h = 1.388... m/s)
const MIN_PREDICT_COLLISION_SPEED = 1.38;

// FIX BUG #18: Wrong-direction threshold lowered from 150 to 120
const WRONG_DIR_DIFF = 120;

// FIX BUG #19: Rear-end decel threshold raised from 2.0 to 3.5 (emergency braking)
const SUDDEN_DECEL = 3.5;

// FIX BUG #23: Collision radius reduced from 4m to 2.5m for two-wheelers
// Bikes are narrower than cars, smaller buffer avoids false positives on multi-lane roads
const COLLISION_RADIUS = 2.5;

// FIX BUG #20: Rear-end distance now scales with speed (minimum 10m)
function getRearEndDistance(speedMs) {
  return Math.max(10, speedMs * 3);
}

// FIX BUG #38: Speed-based nearby radius
function getSpeedBasedRadius(speedMs) {
  const speedKmh = speedMs * 3.6;
  if (speedKmh < 20) return 50;
  if (speedKmh < 40) return 100;
  if (speedKmh < 60) return 150;
  return 200;
}

function getStaleTimeout(speedMs) {
  // FIX BUG #21: Stale timeout based on speed
  // Slow/city traffic: longer timeout (cellular networks)
  // High speed: shorter timeout (safety critical)
  if (speedMs < 5) return 10000; // 10s for slow traffic
  if (speedMs < 14) return 6000; // 6s for moderate speeds
  return 4000; // 4s for high speeds
}

const SERVER_VERSION = "sprint4";

function deterministicThreatId(type, roadId, otherId, timeHorizon) {
  const raw = `${type}|${roadId || "none"}|${otherId || "none"}|${Math.floor(timeHorizon || 0)}`;
  return createHash("sha256").update(raw).digest("hex").substring(0, 12);
}

function computeSeverity(type, speedMs, ttc, distToTurn) {
  // FIX BUG #29: Severity scoring 1-3
  let base = 1;
  const speedKmh = speedMs * 3.6;

  // Higher speed = more severe
  if (speedKmh > 50) base += 1;
  if (speedKmh > 80) base += 1;

  // TTC modifier
  if (ttc !== undefined && ttc < 2) base += 1;

  // Turn modifier: closer to turn = more urgent
  if (distToTurn !== undefined && distToTurn < 20) base += 1;

  // Time of day: night (10PM-6AM) is higher risk
  const hour = new Date().getHours();
  if (hour < 6 || hour >= 22) base += 1;

  return Math.min(3, base);
}

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

// ─── TURN DETECTION HELPERS ───

function deg2rad(d) { return (d * Math.PI) / 180; }

function getBearing(lat1, lon1, lat2, lon2) {
  const dLon = deg2rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(deg2rad(lat2));
  const x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) -
            Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function isInCone(myLat, myLng, myHeading, nodeLat, nodeLng, coneAngleDeg, coneRangeM) {
  const dist = getDistanceInMeters({ lat: myLat, lng: myLng }, { lat: nodeLat, lng: nodeLng });
  if (dist > coneRangeM) return false;
  const bearing = getBearing(myLat, myLng, nodeLat, nodeLng);
  let diff = ((bearing - myHeading) % 360 + 360) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff <= coneAngleDeg;
}

function getAlertThreshold(speedKmh, riskLevel) {
  const base = { 1: 3, 2: 4, 3: 5, 4: 6, 5: 8 };
  const seconds = base[riskLevel] || 4;
  // Scale by speed: faster = more time needed
  return speedKmh > 60 ? seconds + 2 : speedKmh > 40 ? seconds + 1 : seconds;
}

async function getUpcomingTurns(lat, lng, heading, speedMs) {
  try {
    const coneAngle = 60;
    const coneRange = 200;
    const speedKmh = speedMs * 3.6;

    const nearbyTurns = await Turn.find({
      location: {
        $near: {
          $geometry: { type: "Point", coordinates: [lng, lat] },
          $maxDistance: coneRange,
        },
      },
    }).limit(50).lean();

    const upcoming = [];
    for (const turn of nearbyTurns) {
      const [turnLng, turnLat] = turn.location.coordinates;
      if (!isInCone(lat, lng, heading, turnLat, turnLng, coneAngle, coneRange)) continue;

      const distance = getDistanceInMeters({ lat, lng }, { lat: turnLat, lng: turnLng });
      const timeToReach = speedMs > 0.5 ? distance / speedMs : 999;
      const alertThreshold = getAlertThreshold(speedKmh, turn.riskLevel || 1);

      // Check for other vehicles near this turn
      const otherVehicles = nearbyVehicleCache
        ? Array.from(nearbyVehicleCache.values()).filter(v => {
            const vDist = getDistanceInMeters({ lat: turnLat, lng: turnLng }, { lat: v.lat, lng: v.lng });
            return vDist < 40 && v.userId !== undefined;
          })
        : [];

      upcoming.push({
        distance: Math.round(distance),
        timeToReach: Math.round(timeToReach * 10) / 10,
        type: turn.type,
        angle: turn.angle,
        blind: turn.isBlind || false,
        riskLevel: turn.riskLevel || 1,
        alertNow: timeToReach <= alertThreshold,
        lat: turnLat,
        lng: turnLng,
        sightDistance: turn.sightDistance || 100,
        roadName: turn.roadName || "",
        speedLimit: turn.speedLimit,
        isOneWay: turn.isOneWay,
        laneCount: turn.laneCount,
        vehiclesNearby: otherVehicles.length > 0,
        vehicleCount: otherVehicles.length,
      });
    }

    return upcoming.sort((a, b) => a.distance - b.distance);
  } catch (e) {
    console.error("Error getting upcoming turns:", e.message);
    return [];
  }
}

// In-memory cache of nearby vehicles for turn queries
const nearbyVehicleCache = new Map();

// Clean stale entries from nearbyVehicleCache every 30s
setInterval(() => {
  const cutoff = Date.now() - 10000;
  for (const [key, val] of nearbyVehicleCache) {
    if (val.timestamp < cutoff) nearbyVehicleCache.delete(key);
  }
}, 30000);

// Track last heading for turn learning
const lastHeadingMap = new Map();
const lastHeadingTimeMap = new Map();

// WebSocket rate limiting: max 1 message per second per connection
const wsMessageTimestamps = new Map();

// FIX BUG #34: Heartbeat interval
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 10000;

// Start heartbeat pings
setInterval(() => {
  const now = Date.now();
  for (const [uid, ws] of userSockets.entries()) {
    if (!ws._lastPong || now - ws._lastPong > HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS) {
      console.log(`💔 Heartbeat expired for ${uid}, removing`);
      userSockets.delete(uid);
      socketToUser.delete(ws);
      try { ws.close(); } catch {}
    } else if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch {}
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------- WebSocket connection ----------------
// FIX BUG #2: WebSocket JWT authentication
wss.on("connection", (ws, req) => {
  console.log("🔗 New WebSocket client connected");

  // Authenticate via query param token
  const urlParams = new URL(req.url, "http://localhost");
  const token = urlParams.searchParams.get("token");
  let authenticatedUserId = null;

  if (token) {
    try {
      const payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
      authenticatedUserId = payload._id?.toString();
      console.log(`🔐 WebSocket authenticated for userId=${authenticatedUserId}`);
    } catch (err) {
      // In dev mode, allow connections with a special dev token
      if (process.env.DEV_MODE === "true" && token === "dev-token") {
        authenticatedUserId = "dev-user";
        console.log(`🔐 DEV MODE: WebSocket authenticated as dev-user`);
      } else {
        console.warn("⚠️ WebSocket auth failed, rejecting connection");
        ws.close(4001, "Invalid or expired token");
        return;
      }
    }
  } else {
    // In dev mode, allow connections without a token
    if (process.env.DEV_MODE === "true") {
      authenticatedUserId = "dev-user";
      console.log(`🔐 DEV MODE: WebSocket connected without token as dev-user`);
    } else {
      console.warn("⚠️ WebSocket connection without token, rejecting");
      ws.close(4001, "Authentication required");
      return;
    }
  }

  ws._lastPong = Date.now();

  ws.on("pong", () => {
    ws._lastPong = Date.now();
  });

  ws.on("message", async (message) => {
    try {
      // FIX BUG #26: Message size limit (10KB)
      const rawLength = typeof message === "string" ? message.length : message?.length ?? 0;
      if (rawLength > 10240) {
        console.warn("⚠️ Message too large, rejecting");
        ws.send(JSON.stringify({ status: "error", reason: "Message too large (max 10KB)" }));
        return;
      }

      // WebSocket rate limiting (disabled in dev mode)
      if (process.env.DEV_MODE !== "true") {
        const now_ws = Date.now();
        const lastMsg = wsMessageTimestamps.get(authenticatedUserId) || 0;
        if (now_ws - lastMsg < 800) {
          console.warn(`⚠️ Rate limiting WS messages for ${authenticatedUserId}`);
          return;
        }
        wsMessageTimestamps.set(authenticatedUserId, now_ws);
      }

      const raw = typeof message === "string" ? message : message?.toString?.() ?? "";
      console.log("📥 Incoming WS raw:", raw);

      const data = JSON.parse(raw);
      console.log("🧾 Parsed:", data);

      // Validate userId matches authenticated user
      if (!data || typeof data.userId !== "string" || data.userId.trim() === "") {
        console.log("⚠️ validation failed: missing userId");
        ws.send(JSON.stringify({ status: "error", reason: "missing userId" }));
        return;
      }

      // FIX BUG #2: Enforce authenticated userId (skip in dev mode)
      if (process.env.DEV_MODE !== "true" && data.userId !== authenticatedUserId) {
        console.warn(`⚠️ userId mismatch: data=${data.userId} auth=${authenticatedUserId}`);
        ws.send(JSON.stringify({ status: "error", reason: "userId mismatch" }));
        return;
      }

      if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
        console.log("⚠️ validation failed: invalid coordinates");
        ws.send(JSON.stringify({ status: "error", reason: "invalid coordinates" }));
        return;
      }

      console.log(`ℹ️ Processing update for userId=${data.userId}`);

      // FIX BUG #16: Socket close O(1) via reverse map
      userSockets.set(data.userId, ws);
      socketToUser.set(ws, data.userId);
      console.log(`🔗 userSockets set for ${data.userId}`);

      // FIX BUG #30: Vehicle type handling
      const vehicleType = data.vehicleType || "two-wheeler";
      const isTwoWheeler = vehicleType === "two-wheeler";

      // ─── Sprint 1: Time Sync ───
      const clientTimeMs = typeof data.clientTime === "number" ? data.clientTime : Date.now();
      const serverTimeMs = Date.now();
      const rttEstimate = data.serverTime ? (serverTimeMs - clientTimeMs) : 0;
      const timeOffset = data.serverTime ? Math.floor((serverTimeMs - clientTimeMs) / 2) : 0;

      let timeSyncEntry = timeSyncMap.get(data.userId) || { offsets: [], confidence: 1.0 };
      if (data.serverTime) {
        timeSyncEntry.offsets.push(timeOffset);
        if (timeSyncEntry.offsets.length > 20) timeSyncEntry.offsets.shift();
        const meanOffset = timeSyncEntry.offsets.reduce((a, b) => a + b, 0) / timeSyncEntry.offsets.length;
        const variance = timeSyncEntry.offsets.reduce((a, b) => a + (b - meanOffset) ** 2, 0) / timeSyncEntry.offsets.length;
        const stdDev = Math.sqrt(variance);
        timeSyncEntry.confidence = Math.max(0.1, Math.min(1.0, 1.0 - stdDev / 500));
        timeSyncEntry.offset = meanOffset;
      }
      timeSyncMap.set(data.userId, timeSyncEntry);

      // ─── Sprint 1: Map Matching ───
      const sensorQuality = data.sensorQuality ?? 0.8;
      const positionUncertainty = data.positionUncertainty ?? 10;
      const vehicleSpeed = Math.max(0, Number(data.speed ?? 0));

      let matched = {
        matched: false,
        roadId: null,
        snappedLat: data.latitude,
        snappedLng: data.longitude,
        roadHeading: data.heading ?? 0,
        matchConfidence: 0,
        vehicleStateConfidence: 0.5,
      };

      if (roadGraph && roadGraph.initialized && mapMatcher) {
        matched = await mapMatcher.match(
          data.userId,
          data.latitude,
          data.longitude,
          data.heading ?? 0,
          vehicleSpeed,
          positionUncertainty,
          serverTimeMs
        );
      }

      // ─── Track vehicle on road ───
      const prevRoadId = previousRoadMap.get(data.userId);
      previousRoadMap.set(data.userId, matched.roadId);
      if (prevRoadId && prevRoadId !== matched.roadId) {
        const prevSet = roadVehicleMap.get(prevRoadId);
        if (prevSet) prevSet.delete(data.userId);
      }
      if (matched.roadId) {
        if (!roadVehicleMap.has(matched.roadId)) roadVehicleMap.set(matched.roadId, new Set());
        roadVehicleMap.get(matched.roadId).add(data.userId);
      }

      // ─── Track last seen ───
      vehicleLastSeen.set(data.userId, serverTimeMs);

      // ─── Build enriched payload for Redis ───
      const storePayload = {
        ...data,
        rawLatitude: data.latitude,
        rawLongitude: data.longitude,
        latitude: matched.snappedLat,
        longitude: matched.snappedLng,
        heading: matched.roadHeading ?? data.heading ?? 0,
        roadId: matched.roadId,
        roadName: matched.roadName,
        highway: matched.highway,
        matchConfidence: matched.matchConfidence,
        vehicleStateConfidence: matched.vehicleStateConfidence,
        roadConfidence: matched.roadConfidence ?? 0,
        distanceToRoad: matched.distanceToRoad ?? null,
        oneway: matched.oneway,
        maxspeed: matched.maxspeed,
        lanes: matched.lanes,
        sensorQuality,
        positionUncertainty,
        timeSyncConfidence: timeSyncEntry.confidence,
        serverTime: serverTimeMs,
        staleness: "fresh",
      };

      // Persist geo to Redis (GEOADD)
      if (redisConnected && redisClient) {
        try {
          await redisClient.geoAdd("users", {
            longitude: storePayload.longitude,
            latitude: storePayload.latitude,
            member: data.userId,
          });
          console.log(`🗺️ GEOADD users ${data.userId} @ ${storePayload.latitude},${storePayload.longitude}`);
        } catch (e) {
          console.error("❌ Redis GEOADD failed:", e);
        }

        // Persist full payload
        const ttl = data.speed > 5 ? 10 : 30;
        try {
          await redisClient.set(`userData:${data.userId}`, JSON.stringify(storePayload), { EX: ttl });
          console.log(`💾 SET userData:${data.userId} (ttl=${ttl}s)`);
        } catch (e) {
          console.error("❌ Redis SET userData failed:", e);
        }
      } else {
        // Without Redis, skip directly to empty response
        console.warn("⚠️ Redis not connected, sending empty threats");
        try {
          ws.send(JSON.stringify({ status: "received", timestamp: new Date(), threats: [], serverTime: serverTimeMs, serverVersion: SERVER_VERSION, }));
        } catch (e) {
          console.error("❌ Failed to send response:", e);
        }
        return;
      }

      // FIX BUG #6: Gyro conversion - correctly convert ALL axes from rad/s to deg/s
      // Frontend sensors_plus sends gyro in rad/s
      const gyroRaw = data.gyro || {};
      const gyroXDeg = (gyroRaw.x || 0) * (180 / Math.PI);
      const gyroYDeg = (gyroRaw.y || 0) * (180 / Math.PI);
      const gyroZDeg = (gyroRaw.z || 0) * (180 / Math.PI);
      const gyroMagnitude = Math.sqrt(gyroXDeg * gyroXDeg + gyroYDeg * gyroYDeg + gyroZDeg * gyroZDeg);
      const isSuddenTurn = gyroMagnitude >= CONFIG.ANGULAR_VEL_HIGH_DEG_S;

      // FIX BUG #38: Speed-based nearby radius (not just gyro-based)
      const speedMs_self = Math.max(0, Number(data.speed ?? 0));
      const speedRadius = getSpeedBasedRadius(speedMs_self);
      const nearbyRadius = Math.max(speedRadius, CONFIG.NEARBY_RADIUS_METERS) +
        (isSuddenTurn ? CONFIG.BLIND_SPOT_RADIUS_BOOST_METERS : 0);
      console.log(`🧭 speed=${speedMs_self.toFixed(1)}m/s gyroMag=${gyroMagnitude.toFixed(1)}°/s radius=${nearbyRadius}m`);

      // FIX BUG #32: Nearby user caching
      // Use module-level getDistanceInMeters to avoid TDZ issue with local haversineMeters
      const prevCache = nearbyCache.get(data.userId);
      let shouldRescan = true;
      if (prevCache) {
        const timeSince = Date.now() - prevCache.timestamp;
        const distSince = getDistanceInMeters(
          { lat: prevCache.lat, lng: prevCache.lng },
          { lat: data.latitude, lng: data.longitude }
        );
        if (timeSince < NEARBY_CACHE_TTL_MS && distSince < NEARBY_CACHE_MOVE_THRESHOLD_M) {
          shouldRescan = false;
        }
      }

      let nearbyUserIds = [];
      let otherIds = [];
      let usersData = [];
      let roadBubbleUsed = false;
      let rawNearbyCount = 0;

      if (shouldRescan) {
        // ─── Sprint 2: Road Distance Bubble ───
        if (matched.roadId && roadGraph && roadGraph.initialized) {
          const horizonMeters = Math.min(vehicleSpeed * 8, 500);
          const reachableRoads = roadGraph.getReachableRoads(matched.roadId, horizonMeters, vehicleSpeed, matched.roadHeading || data.heading || 0);
          const reachableRoadIds = new Set(reachableRoads.map(r => r.roadId));
          reachableRoadIds.add(matched.roadId);

          const userIdsOnReachableRoads = new Set();
          for (const rid of reachableRoadIds) {
            const vehicles = roadVehicleMap.get(rid);
            if (vehicles) {
              for (const uid of vehicles) userIdsOnReachableRoads.add(uid);
            }
          }

          // Also get Euclidean for vehicles not yet in road map (first message)
          if (userIdsOnReachableRoads.size < 3) {
            try {
              const euclideanIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
              for (const uid of euclideanIds) userIdsOnReachableRoads.add(uid);
            } catch (e) {
              console.error("❌ Redis geoRadiusByMember failed:", e);
            }
          }

          nearbyUserIds = Array.from(userIdsOnReachableRoads);
          rawNearbyCount = nearbyUserIds.length;
          roadBubbleUsed = true;
          console.log(`🔎 Road bubble: ${reachableRoadIds.size} roads, ${nearbyUserIds.length} users (horizon=${horizonMeters}m)`);
        } else {
          // Euclidean fallback
          try {
            nearbyUserIds = await redisClient.geoRadiusByMember("users", data.userId, nearbyRadius, "m", { COUNT: 50 });
          } catch (e) {
            console.error("❌ Redis geoRadiusByMember failed:", e);
          }
          rawNearbyCount = nearbyUserIds.length;
        }

        nearbyCache.set(data.userId, {
          nearbyIds: nearbyUserIds,
          timestamp: Date.now(),
          lat: data.latitude,
          lng: data.longitude,
        });
      } else {
        nearbyUserIds = prevCache.nearbyIds;
        console.log(`🔎 Using cached nearby list (${nearbyUserIds.length} members)`);
      }

      otherIds = nearbyUserIds.filter(uid => uid !== data.userId);
      console.log(`👥 otherIds (excluding self): ${otherIds.length}`, otherIds);

      if (otherIds.length === 0) {
        ws.send(JSON.stringify({
          status: "received",
          timestamp: new Date(),
          serverTime: Date.now(),
          serverVersion: SERVER_VERSION,
          timeSyncConfidence: timeSyncEntry?.confidence ?? 1.0,
          threats: [],
          mapMatch: {
            matched: matched.matched,
            confidence: matched.matchConfidence ?? 0,
            roadId: matched.roadId,
            snappedLat: matched.snappedLat,
            snappedLng: matched.snappedLng,
            distanceToRoad: matched.distanceToRoad ?? null,
            vehicleStateConfidence: matched.vehicleStateConfidence ?? 0.5,
          },
          roadBubble: {
            used: roadBubbleUsed,
            rawCount: rawNearbyCount,
            filteredCount: nearbyUserIds.length,
            reduction: rawNearbyCount > 0 ? ((1 - nearbyUserIds.length / rawNearbyCount) * 100).toFixed(0) + "%" : "0%",
          },
        }));
        console.log("📤 No neighbors -> returning empty threats");
        return;
      }

      const keys = otherIds.map(uid => `userData:${uid}`);
      try {
        usersData = await redisClient.mGet(keys);
        console.log(`📦 mGet returned ${usersData.length} entries`);
      } catch (e) {
        console.error("❌ Redis mGet failed:", e);
      }

      // ─── Sprint 1: Road Eligibility Filter ───
      const selfRoadId = matched.roadId;
      if (selfRoadId && roadGraph && roadGraph.initialized) {
        const filteredIds = [];
        const filteredData = [];
        for (let i = 0; i < otherIds.length; i++) {
          const uid = otherIds[i];
          const raw = usersData[i];
          if (!raw) continue;
          try {
            const otherParsed = JSON.parse(raw);
            const otherRoadId = otherParsed.roadId;
            if (otherRoadId) {
              if (roadGraph.areRoadsConnected(selfRoadId, otherRoadId, 2)) {
                filteredIds.push(uid);
                filteredData.push(raw);
              } else {
                console.log(`⏭️ Skipping ${uid} (road ${otherRoadId}) — not reachable from ${selfRoadId}`);
              }
            } else {
              filteredIds.push(uid);
              filteredData.push(raw);
            }
          } catch {
            filteredIds.push(uid);
            filteredData.push(raw);
          }
        }
        otherIds = filteredIds;
        usersData = filteredData;
        console.log(`🔎 After road eligibility: ${otherIds.length} vehicles remain`);
      }

      // ─── Sprint 1: Staleness Check ───
      const stalenessCache = new Map();
      for (let i = otherIds.length - 1; i >= 0; i--) {
        const uid = otherIds[i];
        const lastSeen = vehicleLastSeen.get(uid);
        if (lastSeen) {
          const staleClass = classifyStaleness(lastSeen);
          stalenessCache.set(uid, staleClass);
          if (staleClass === "expired") {
            otherIds.splice(i, 1);
            usersData.splice(i, 1);
            console.log(`⏳ Removed expired vehicle ${uid} from consideration`);
          }
        }
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

      // ─── ETA Registry ───
      if (etaRegistry && matched.matched) {
        const tracks = etaRegistry.junctions.size;
        etaRegistry.update(data.userId, matched, matched.snappedLat, matched.snappedLng, matched.roadHeading, vehicleSpeed, {
          timeSyncQuality: timeSyncEntry.confidence,
        });

        const etaConflicts = etaRegistry.getPendingConflicts();
        if (etaConflicts.length > 0) {
          console.log(`🚦 ETA conflicts detected for ${data.userId}: ${etaConflicts.length} (tracks=${tracks})`);
        }
        for (const conflict of etaConflicts) {
          if (conflict.probability > 0.3) {
                const icAlertConf = computeAlertConfidence(
                  conflict.probability,
                  matched.matchConfidence || 0.5,
                  sensorQuality,
                  matched.roadConfidence || 0.5,
                  matched.vehicleStateConfidence || 0.5
                );
                const icAlertClass = classifyAlert(icAlertConf, "balanced");
                threats.push({
                  type: "intersection_collision",
                  id: conflict.vehicleB.userId,
                  lat: conflict.junctionLat,
                  lng: conflict.junctionLng,
                  severity: conflict.probability > 0.7 ? 3 : 2,
                  collisionProbability: conflict.probability,
                  alertConfidence: icAlertConf,
                  alertClass: icAlertClass,
                  etaSelf: conflict.vehicleA.eta,
                  etaOther: conflict.vehicleB.eta,
              etaDiff: conflict.etaDiff,
              junctionType: conflict.junctionType,
              message: "🚦 Vehicles approaching same junction",
            });
          }
        }
      }

      // detection config
      // FIX BUG #8: Predicted collision uses 0.5s steps (10 checkpoints instead of 5)
      const LOOKAHEAD_S = 8;
      const PREDICT_STEP = 0.5;

      // maintain short in-memory speed history for self
      if (!global.speedHistory) global.speedHistory = {};
      if (!global.speedHistory[data.userId]) global.speedHistory[data.userId] = [];
      // FIX BUG #33: Cap at 10 samples
      global.speedHistory[data.userId].push({ speed: speedSelf, t: now });
      global.speedHistory[data.userId] = global.speedHistory[data.userId].slice(-10);

      function predictTrajectory(lat, lng, roadId, heading, speed, confidence, horizonSeconds) {
        // Road-constrained trajectory if we have a road match
        if (roadId && roadGraph && roadGraph.initialized && confidence >= 0.3) {
          const trajectory = roadGraph.getTrajectory(roadId, lat, lng, heading, speed, horizonSeconds);
          if (trajectory && trajectory.length > 0) return trajectory;
        }
        // Fallback: straight-line prediction
        const points = [];
        const stepS = 0.5;
        const totalSteps = Math.ceil(horizonSeconds / stepS);
        for (let step = 1; step <= totalSteps; step++) {
          const t = step * stepS;
          const dist = speed * t;
          const p = projectPoint(lat, lng, heading, dist);
          points.push({ lat: p.lat, lng: p.lng, t });
        }
        return points;
      }

      // FIX BUG #10: Majority direction calculated from OTHER vehicles only
      let otherHeadings = [];
      for (let i = 0; i < otherIds.length; i++) {
        const raw = usersData[i];
        if (!raw) continue;
        try {
          const otherTmp = JSON.parse(raw);
          otherHeadings.push(normalizeHeadingDeg(Number(otherTmp.heading ?? 0)));
        } catch (e) {
          console.log(`⚠️ malformed usersData[${i}] for ${otherIds[i]}`);
        }
      }
      function avgHeading(arr) {
        if (arr.length === 0) return null;
        let x = 0, y = 0;
        for (let h of arr) {
          const rad = (h * Math.PI) / 180;
          x += Math.cos(rad);
          y += Math.sin(rad);
        }
        if (x === 0 && y === 0) return 0;
        return (Math.atan2(y, x) * 180) / Math.PI;
      }
      const majorityDirection = otherHeadings.length >= 2
        ? normalizeHeadingDeg(avgHeading(otherHeadings))
        : null;
      console.log(`📐 majorityDirection=${majorityDirection} based on ${otherHeadings.length} other vehicles`);

      // (index.js core loop fix check)
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
          const staleTimeout = getStaleTimeout(speedSelf);
          if (!Number.isFinite(otherTs) || now - otherTs > staleTimeout) {
            console.log(`⏳ skipping ${uid} because stale: ageMs=${Number.isFinite(otherTs) ? (now - otherTs) : "invalid"} timeout=${staleTimeout}`);
            continue;
          }

          const headingOther = normalizeHeadingDeg(Number(other.heading ?? 0));
          const speedOther = Math.max(0, Number(other.speed ?? 0));

          // Update nearby vehicle cache for turn queries
          nearbyVehicleCache.set(uid, {
            userId: uid,
            lat: other.latitude,
            lng: other.longitude,
            speed: speedOther,
            heading: headingOther,
            timestamp: now,
          });

          const distNow = haversineMeters(baseLat, baseLon, other.latitude, other.longitude);
          const hdiff = headingDiff(headingSelf, headingOther);

          // LOG distance & heading diff
          console.log(`📏 [${data.userId} ↔ ${uid}] distNow=${distNow.toFixed(2)}m headingDiff=${hdiff}° speedSelf=${speedSelf} speedOther=${speedOther}`);

        // ----------------------------------------------------
        // TURN COLLISION DETECTION
        // FIX BUG #7: Fire if EITHER vehicle detects the turn, not BOTH
        // FIX BUG #22: Remove +0.1 hack, check speed > 0.5 m/s before ETA
        // ----------------------------------------------------
        try {
          const selfTurn = data.turnAhead === true;
          const otherTurn = other.turnAhead === true;

          // Fire if EITHER vehicle detected a turn AND speeds > minimum
          if (
            (selfTurn || otherTurn) &&
            data.intersectionLat != null &&
            other.intersectionLat != null &&
            speedSelf > MIN_PREDICT_COLLISION_SPEED &&
            speedOther > MIN_PREDICT_COLLISION_SPEED
          ) {
            const turnA = { lat: data.intersectionLat, lng: data.intersectionLng };
            const turnB = { lat: other.intersectionLat, lng: other.intersectionLng };

            const turnDist = haversineMeters(turnA.lat, turnA.lng, turnB.lat, turnB.lng);

            if (turnDist <= 8) {
              const distSelfToTurn = haversineMeters(baseLat, baseLon, turnA.lat, turnA.lng);
              const distOtherToTurn = haversineMeters(other.latitude, other.longitude, turnA.lat, turnA.lng);

              // FIX BUG #22: Only compute ETA if speed is meaningful
              let etaSelf = Infinity, etaOther = Infinity;
              if (speedSelf > 0.5) etaSelf = distSelfToTurn / speedSelf;
              if (speedOther > 0.5) etaOther = distOtherToTurn / speedOther;

              console.log("TURN DATA RECEIVED:", data.intersectionLat, data.intersectionLng);
              console.log("TURN MATCH DISTANCE:", turnDist);
              console.log("TURN ETA SELF:", etaSelf);
              console.log("TURN ETA OTHER:", etaOther);

              // FIX BUG #7: Extended overlap window to 3 seconds
              if (Math.abs(etaSelf - etaOther) <= 3.0) {
                // Compute severity based on junction risk
                const riskScore = getJunctionRiskScore(turnA.lat, turnA.lng);
                const severity = computeSeverity("turn", speedSelf, Math.min(etaSelf, etaOther), distSelfToTurn);

                updateJunctionRisk(turnA.lat, turnA.lng);

                // FIX BUG #29: Include severity and riskScore in payload
                const payloadSelf = {
                  type: "turn_collision",
                  id: other.userId ?? uid,
                  lat: other.latitude,
                  lng: other.longitude,
                  intersectionLat: turnA.lat,
                  intersectionLng: turnA.lng,
                  severity,
                  riskScore,
                  eta: Math.min(etaSelf, etaOther),
                  message: "⚠️ Collision risk at turn ahead",
                };

                threats.push(payloadSelf);
                console.log("🚨 TURN COLLISION THREAT (SELF):", payloadSelf);

                const wsOther = userSockets.get(uid);
                if (wsOther && wsOther.readyState === wsOther.OPEN) {
                  const payloadOther = {
                    type: "turn_collision",
                    id: data.userId,
                    lat: data.latitude,
                    lng: data.longitude,
                    intersectionLat: turnA.lat,
                    intersectionLng: turnA.lng,
                    severity,
                    riskScore,
                    eta: Math.min(etaSelf, etaOther),
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

          // FIX BUG #21: Use dynamic stale timeout
          const staleMs = getStaleTimeout(speedSelf);

          if (speedSelf < MIN_PREDICT_COLLISION_SPEED && speedOther < MIN_PREDICT_COLLISION_SPEED) {
            console.log(`⛔ Skipping predicted collision: both too slow (<5km/h).`);
            continue;
          }

          // 1) Predicted collision check — Sprint 3: Road-constrained trajectory + probability
          const selfTrajectory = predictTrajectory(
            data.latitude, data.longitude, matched.roadId,
            headingSelf, speedSelf, matched.matchConfidence || 0, LOOKAHEAD_S
          );
          const otherTrajectory = predictTrajectory(
            other.latitude, other.longitude, other.roadId,
            headingOther, speedOther, other.matchConfidence || 0, LOOKAHEAD_S
          );

          let highestCollisionProbability = 0;
          let bestTimeHorizon = 0;
          let bestPredDist = Infinity;

          const maxSteps = Math.min(selfTrajectory.length, otherTrajectory.length);
          for (let idx = 0; idx < maxSteps; idx++) {
            const sp = selfTrajectory[idx];
            const op = otherTrajectory[idx];
            const t = sp.t || (idx + 1) * 0.5;
            const dPred = haversineMeters(sp.lat, sp.lng, op.lat, op.lng);

            const selfUncertainty = computePredictionUncertainty({
              timeHorizon: t,
              speedMs: speedSelf,
              sensorQuality: other.sensorQuality ?? 0.8,
              mapMatchConfidence: other.matchConfidence ?? 0,
              roadConfidence: other.roadConfidence ?? 0.5,
              networkRttMs: 0,
              positionUncertainty: other.positionUncertainty ?? 10,
              timeSinceLastUpdateMs: 0,
            });

            const otherUncertainty = computePredictionUncertainty({
              timeHorizon: t,
              speedMs: speedOther,
              sensorQuality: other.sensorQuality ?? 0.8,
              mapMatchConfidence: other.matchConfidence ?? 0,
              roadConfidence: other.roadConfidence ?? 0.5,
              networkRttMs: 0,
              positionUncertainty: other.positionUncertainty ?? 10,
              timeSinceLastUpdateMs: other.serverTime ? (now - other.serverTime) : 0,
            });

            const collisionProb = computeOverlapProbability(dPred, selfUncertainty, otherUncertainty);

            if (collisionProb > highestCollisionProbability) {
              highestCollisionProbability = collisionProb;
              bestTimeHorizon = t;
              bestPredDist = dPred;
            }
          }

          if (highestCollisionProbability > 0.2) {
            const alertConfidence = computeAlertConfidence(
              highestCollisionProbability,
              matched.matchConfidence || 0.5,
              sensorQuality,
              matched.roadConfidence || 0.5,
              matched.vehicleStateConfidence || 0.5
            );

            const alertClass = classifyAlert(alertConfidence, "balanced");
            const severity = alertConfidence >= 0.7 ? 3 : alertConfidence >= 0.5 ? 2 : 1;

            if (alertClass !== "ignore") {
              const payloadSelf = {
                type: "predicted_collision",
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
                future_distance_m: Number(bestPredDist.toFixed(2)),
                time_s: bestTimeHorizon,
                severity,
                collisionProbability: highestCollisionProbability,
                alertConfidence,
                alertClass,
                message: "⚠️ Predicted collision based on future paths"
              };

              console.log(`🚨 PREDICTED COLLISION: prob=${(highestCollisionProbability * 100).toFixed(0)}% conf=${(alertConfidence * 100).toFixed(0)}% class=${alertClass}`);
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
                  future_distance_m: Number(bestPredDist.toFixed(2)),
                  time_s: bestTimeHorizon,
                  severity,
                  collisionProbability: highestCollisionProbability,
                  alertConfidence,
                  alertClass,
                  message: "⚠️ Predicted collision based on future paths"
                };

                try {
                  wsOther.send(JSON.stringify({ status: "threat", data: payloadOther }));
                  console.log(`📣 Sent predicted_collision to other ${uid}`);
                } catch (e) {
                  console.error(`❌ Failed to send predicted_collision to ${uid}:`, e);
                }
              }
            } else {
              console.log(`🔇 Predicted collision suppressed (confidence ${(alertConfidence * 100).toFixed(0)}% below alert threshold)`);
            }
          }

          // 2) Rear-end detection
          // FIX BUG #9: Use median of last 5 speed samples, require 3 consecutive
          const otherHist = global.speedHistory[other.userId] ?? [];
          if (otherHist.length >= 3) {
            // Use rolling window of last 5 samples
            const window = otherHist.slice(-5);
            const decels = [];
            for (let j = 1; j < window.length; j++) {
              const dt = (window[j].t - window[j-1].t) / 1000 || 1;
              decels.push((window[j-1].speed - window[j].speed) / dt);
            }
            // Use median deceleration (filter out GPS glitch spikes)
            const sorted = [...decels].sort((a, b) => a - b);
            const medianDecel = sorted.length % 2 === 0
              ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
              : sorted[Math.floor(sorted.length / 2)];

            // FIX BUG #9: Require at least 3 deceleration samples above threshold
            const aboveThreshold = decels.filter(d => d >= SUDDEN_DECEL).length;

            // FIX BUG #20: Dynamic rear-end distance based on speed
            const rearEndDist = getRearEndDistance(speedOther);
            const relativeDist = distNow;
            const closingSpeed = speedSelf - speedOther;

            console.log(`🛑 Rear-check ${uid}: medianDecel=${medianDecel.toFixed(2)}m/s² aboveThreshold=${aboveThreshold}/${decels.length} closingSpeed=${closingSpeed.toFixed(2)}m/s relativeDist=${relativeDist.toFixed(2)}m thresholdDist=${rearEndDist.toFixed(1)}m`);

            if (medianDecel >= SUDDEN_DECEL && aboveThreshold >= 3 && relativeDist <= rearEndDist && closingSpeed > 0.5) {
              const severity = computeSeverity("rear_end", speedOther, null, relativeDist);

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
                deceleration: Number(medianDecel.toFixed(2)),
                severity,
                message: "🚨 Rear-end danger! Front vehicle is braking hard"
              };

              // Update junction risk for nearby turns
              if (data.intersectionLat) {
                updateJunctionRisk(data.intersectionLat, data.intersectionLng);
              }

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
                  deceleration: Number(medianDecel.toFixed(2)),
                  severity,
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

          // 3) Wrong-direction detection
          // FIX BUG #10: Only run if we have a valid majority from other vehicles
          // FIX BUG #18: Use corrected threshold of 120 degrees
          if (majorityDirection !== null) {
            const headingDifferenceFromMajority = headingDiff(headingOther, majorityDirection);
            console.log(`↔️ Wrong-direction check ${uid}: diffFromMajority=${headingDifferenceFromMajority}° (threshold=${WRONG_DIR_DIFF})`);

            // FIX BUG #38: Dynamic wrong-direction detection range based on speed
            const wrongDirRange = getSpeedBasedRadius(speedOther);

            if (headingDifferenceFromMajority >= WRONG_DIR_DIFF && distNow <= wrongDirRange) {
              const severity = computeSeverity("wrong_direction", speedOther, null, distNow);

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
                severity,
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
                  severity,
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
          } else {
            console.log(`↔️ Skipping wrong-direction check: insufficient data (need >=2 other vehicles)`);
          }

          // MISSING FEATURE 31: One-way road detection
          // If the other vehicle's road has a oneway tag and they're going wrong way
          if (other.oneway === "yes" || other.oneway === "true" || other.oneway === "-1") {
            // Check if heading is opposite to road direction
            // Road direction can be inferred from road geometry bearing
            console.log(`⚠️ ${uid} is on a one-way road (oneway=${other.oneway})`);
          }

          console.log(`✅ No threat detected for neighbor ${uid}`);
        } catch (innerErr) {
          console.error("❌ Error processing nearby user:", otherIds[i], innerErr);
        }
      } // end for otherIds

      // Get upcoming turns for this vehicle
      const upcomingTurns = await getUpcomingTurns(baseLat, baseLon, headingSelf, speedSelf);

      // Add turn learning: detect heading changes > 20 degrees
      const prevHeading = lastHeadingMap.get(data.userId);
      const prevTime = lastHeadingTimeMap.get(data.userId) || 0;
      if (prevHeading !== undefined && Date.now() - prevTime <= 3000) {
        const headingChange = Math.abs(headingSelf - prevHeading);
        if (headingChange > 20 && speedSelf > 1.38) {
          // Record turning event for auto-learning (fire-and-forget)
          TurningEvent.create({
            userId: data.userId,
            location: {
              type: "Point",
              coordinates: [baseLon, baseLat],
            },
            headingBefore: prevHeading,
            headingAfter: headingSelf,
            angleChange: headingChange,
            speed: speedSelf,
            timestamp: new Date(),
          }).catch(() => {});

          // Check if 5+ turning events at this location → auto-create turn (fire-and-forget)
          TurningEvent.countDocuments({
            location: {
              $near: {
                $geometry: { type: "Point", coordinates: [baseLon, baseLat] },
                $maxDistance: 20,
              },
            },
            timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          }).then((nearbyEvents) => {
            if (nearbyEvents >= 5) {
              Turn.findOne({
                location: {
                  $near: {
                    $geometry: { type: "Point", coordinates: [baseLon, baseLat] },
                    $maxDistance: 15,
                  },
                },
              }).then((existingTurn) => {
                if (!existingTurn) {
                  Turn.create({
                    location: { type: "Point", coordinates: [baseLon, baseLat] },
                    type: headingChange > 60 ? "sharp_turn" : "moderate_turn",
                    angle: Math.round(headingChange),
                    riskLevel: headingChange > 60 ? 3 : 2,
                    isBlind: true,
                    junctionCount: 2,
                    approachVectors: [{ heading: prevHeading }, { heading: headingSelf }],
                  }).then(() => {
                    console.log(`🔄 Auto-created turn from rider behavior at ${baseLat},${baseLon}`);
                  }).catch(() => {});
                }
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }
      lastHeadingMap.set(data.userId, headingSelf);
      lastHeadingTimeMap.set(data.userId, Date.now());

      // send threats back to origin + upcoming turns
      console.log(`📤 Finished checks. Returning ${threats.length} threat(s), ${upcomingTurns.length} upcoming turn(s) to ${data.userId}`);

      // Sprint 1: Include time sync + road info in response
      // Phase 1: Add deterministic threat IDs for replay validation
      const selfRoad = matched.roadId ? roadGraph?.getRoad(matched.roadId) : null;

      for (const t of threats) {
        if (!t.threatId) {
          t.threatId = deterministicThreatId(t.type, matched.roadId, t.id, t.time_s || t.eta || 0);
        }
      }

      try {
        ws.send(JSON.stringify({
           status: "received",
          timestamp: new Date(),
          serverTime: Date.now(),
          serverVersion: SERVER_VERSION,
          timeSyncConfidence: timeSyncEntry?.confidence ?? 1.0,
          threats,
          upcomingTurns,
          currentRoadInfo: {
            speedLimit: selfRoad?.maxspeed || null,
            isOneWay: matched.oneway || null,
            laneCount: matched.lanes || null,
            roadName: matched.roadName || selfRoad?.name || null,
            highway: matched.highway || null,
            roadId: matched.roadId,
            roadConfidence: matched.roadConfidence ?? null,
            matchConfidence: matched.matchConfidence ?? null,
          },
          mapMatch: {
            matched: matched.matched,
            confidence: matched.matchConfidence ?? 0,
            roadId: matched.roadId,
            roadName: matched.roadName,
            highway: matched.highway,
            snappedLat: matched.snappedLat,
            snappedLng: matched.snappedLng,
            vehicleStateConfidence: matched.vehicleStateConfidence ?? 0.5,
          },
          roadBubble: {
            used: roadBubbleUsed,
            rawCount: rawNearbyCount,
            filteredCount: nearbyUserIds.length,
            reduction: rawNearbyCount > 0 ? ((1 - nearbyUserIds.length / rawNearbyCount) * 100).toFixed(0) + "%" : "0%",
          },
        }));
      } catch (e) {
        console.error("❌ Failed to send response to origin:", e);
      }

    } catch (err) {
      console.error("❌ WebSocket message handling error:", err);
      try {
        ws.send(JSON.stringify({ status: "error", reason: "Server error processing message" }));
      } catch {}
    }
  });

  // FIX BUG #16: O(1) socket close cleanup via reverse map
  ws.on("close", () => {
    const uid = socketToUser.get(ws);
    if (uid) {
      userSockets.delete(uid);
      socketToUser.delete(ws);
      // Clean up cached data for this user
      nearbyCache.delete(uid);
      wsMessageTimestamps.delete(uid);
      console.log(`🔌 Removed socket mapping for ${uid}`);
    }
    console.log("❌ WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
    const uid = socketToUser.get(ws);
    if (uid) {
      userSockets.delete(uid);
      socketToUser.delete(ws);
    }
  });
}); // end wss.on("connection")

// Sprint 1: Road graph initialization
async function initRoadGraph() {
  try {
    roadGraph = new RoadGraph();
    await roadGraph.loadFromMongo();
    mapMatcher = new MapMatcher(roadGraph);
    etaRegistry = new EtaRegistry(roadGraph);
    etaRegistry.on("junctionConflict", (conflict) => {
      console.log(`🚦 Junction conflict at ${conflict.junction}: probability=${(conflict.probability * 100).toFixed(0)}%`);
    });
    console.log("✅ Road graph, map matcher, and ETA registry initialized");
  } catch (err) {
    console.error("❌ Road graph initialization failed:", err.message);
    console.warn("⚠️ Continuing without road graph (limited functionality)");
  }
}

// Start Mongo + Redis + server
async function startServer() {
  await initRedis();

  mongoose
    .connect(process.env.MONGO_URI)
    .then(async () => {
      console.log("✅ MongoDB connected");
      await initRoadGraph();
      const PORT = process.env.PORT || 5000;
      server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    })
    .catch((err) => console.error("❌ MongoDB connection error:", err));
}

startServer();
