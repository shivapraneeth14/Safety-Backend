import mongoose from "mongoose";
import dotenv from "dotenv";
import { createReadStream } from "fs";
import osmPbf from "osm-pbf-parser";
import Road from "../Models/Road.Model.js";
import Turn from "../Models/Turn.Model.js";

// FIX ISSUE #33: memory monitoring for OOM prevention
const MEMORY_WARN_MB = 3000;
const MEMORY_CRITICAL_MB = 4000;
const MEMORY_CHECK_INTERVAL = 5000; // ms
let lastMemCheck = 0;

function checkMemory(phase) {
  const now = Date.now();
  if (now - lastMemCheck < MEMORY_CHECK_INTERVAL) return;
  lastMemCheck = now;
  const usage = process.memoryUsage();
  const rssMB = Math.round(usage.rss / 1024 / 1024);
  const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
  if (rssMB > MEMORY_CRITICAL_MB) {
    console.error(`\n❌ CRITICAL: RSS ${rssMB}MB exceeds ${MEMORY_CRITICAL_MB}MB limit.`);
    console.error("   This dataset requires more memory than available.");
    console.error("   Try splitting the PBF file with `osmium extract` or increase system memory.");
    process.exit(1);
  }
  if (rssMB > MEMORY_WARN_MB) {
    console.warn(`⚠️  WARNING: RSS ${rssMB}MB (heap ${heapMB}MB) at ${phase} — approaching limit`);
    if (global.gc) {
      global.gc();
      console.warn("   Garbage collection triggered");
    }
  }
}

dotenv.config();

const OSM_PBF_PATH = process.argv[2] || "data/southern-zone-latest.osm.pbf";
const BATCH_SIZE = 500;
const MAX_NODES_IN_MEMORY = 5000000;

const DRIVING_HIGHWAYS = new Set([
  "motorway", "motorway_link",
  "trunk", "trunk_link",
  "primary", "primary_link",
  "secondary", "secondary_link",
  "tertiary", "tertiary_link",
  "residential", "service", "unclassified", "living_street", "road",
]);

function deg2rad(deg) { return (deg * Math.PI) / 180; }

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = deg2rad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(deg2rad(lat2));
  const x = Math.cos(deg2rad(lat1)) * Math.sin(deg2rad(lat2)) -
            Math.sin(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function normalizeAngle(a) {
  return ((a % 360) + 360) % 360;
}

function angleDifference(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function classifyTurnAngle(angleDeg) {
  if (angleDeg < 15) return { type: "straight", riskLevel: 1 };
  if (angleDeg < 30) return { type: "slight_curve", riskLevel: 1 };
  if (angleDeg < 60) return { type: "moderate_turn", riskLevel: 2 };
  if (angleDeg < 90) return { type: "sharp_turn", riskLevel: 3 };
  if (angleDeg < 120) return { type: "very_sharp_turn", riskLevel: 4 };
  return { type: "hairpin_turn", riskLevel: 5 };
}

function classifyByRoadCount(count) {
  if (count <= 1) return "dead_end";
  if (count === 2) return "bend";
  if (count === 3) return "t_junction";
  if (count === 4) return "cross";
  return "complex";
}

function getTurnTypeByRoadCountAndAngle(count, angleDeg) {
  if (count === 1) return "dead_end";
  if (count === 2) {
    if (angleDeg < 15) return "straight";
    if (angleDeg < 30) return angleDeg >= 0 ? "gentle_curve_right" : "gentle_curve_left";
    if (angleDeg < 60) return angleDeg >= 0 ? "right" : "left";
    if (angleDeg < 90) return angleDeg >= 0 ? "sharp_right" : "sharp_left";
    if (angleDeg < 180) return angleDeg >= 0 ? "hairpin_right" : "hairpin_left";
    return "straight";
  }
  if (count === 3) {
    // Check angle distribution — Y-junction vs T-junction
    if (angleDeg < 45) return "y_junction";
    return "t_junction";
  }
  if (count === 4) return "cross";
  return "complex";
}

function estimateBlind(isCurved, speedLimit) {
  if (isCurved && speedLimit && speedLimit > 50) return true;
  if (isCurved) return true;
  return false;
}

function estimateSightDistance(angleDeg) {
  // Sharper turns = shorter sight distance
  if (angleDeg > 90) return 15;
  if (angleDeg > 60) return 25;
  if (angleDeg > 30) return 40;
  if (angleDeg > 15) return 60;
  return 100;
}

async function importRoads() {
  console.log("Starting road import from PBF...");

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const nodeLocations = new Map();
  const nodeToWays = new Map();
  const ways = [];
  let nodeCount = 0;
  let wayCount = 0;

  console.log(`Reading ${OSM_PBF_PATH} ...`);

  // Pass 1: Read all nodes and ways
  await new Promise((resolve, reject) => {
    createReadStream(OSM_PBF_PATH)
      .pipe(osmPbf())
      .on("data", (items) => {
        checkMemory("parse");
        for (const item of items) {
          if (item.type === "node") {
            nodeLocations.set(item.id, { lat: item.lat, lon: item.lon });
            nodeCount++;
          } else if (item.type === "way") {
            const highway = item.tags?.highway;
            if (!highway || !DRIVING_HIGHWAYS.has(highway)) continue;

            const nodeIds = item.refs;
            if (!nodeIds || nodeIds.length < 2) continue;

            const coordinates = nodeIds
              .map((id) => {
                const loc = nodeLocations.get(id);
                return loc ? [loc.lon, loc.lat] : null;
              })
              .filter(Boolean);

            if (coordinates.length < 2) continue;

            const way = {
              osmId: item.id,
              name: item.tags?.name || "",
              highway,
              nodes: nodeIds,
              coordinates,
              oneway: item.tags?.oneway || undefined,
              maxspeed: item.tags?.maxspeed || undefined,
              ref: item.tags?.ref || undefined,
              lanes: item.tags?.lanes || undefined,
              width: item.tags?.width || undefined,
              surface: item.tags?.surface || undefined,
              junction: item.tags?.junction || undefined,
            };

            ways.push(way);
            wayCount++;

            // Map nodes to ways for intersection detection
            for (const nid of nodeIds) {
              if (!nodeToWays.has(nid)) nodeToWays.set(nid, []);
              const list = nodeToWays.get(nid);
              if (!list.includes(item.id)) list.push(item.id);
            }
          }
        }
      })
      .on("end", resolve)
      .on("error", reject);
  });

  if (nodeCount > MAX_NODES_IN_MEMORY) {
    console.warn(`Warning: ${nodeCount} nodes may exceed memory. For very large PBF files, use a regional extract.`);
  }
  checkMemory("post-parse");
  console.log(`Parsed ${nodeCount} nodes, ${wayCount} roads`);

  if (ways.length === 0) {
    console.log("No roads found to import");
    await mongoose.disconnect();
    return;
  }

  // Pass 2: Calculate turns at each shared node
  console.log("Calculating turns at junctions...");
  const turns = [];
  const processedNodes = new Set();
  const wayIndex = new Map(ways.map(w => [w.osmId, w]));

  for (const way of ways) {
    checkMemory("turns");
    for (let i = 0; i < way.nodes.length; i++) {
      const nodeId = way.nodes[i];
      if (processedNodes.has(nodeId)) continue;

      const sharedWays = nodeToWays.get(nodeId) || [];
      if (sharedWays.length < 2) continue; // Skip non-junction nodes

      processedNodes.add(nodeId);
      const nodeLoc = nodeLocations.get(nodeId);
      if (!nodeLoc) continue;

      const approachVectors = [];
      let maxAngle = 0;
      let turnType = classifyByRoadCount(sharedWays.length);

      // Get approach vectors for each way at this node
      for (const wayId of sharedWays) {
        const w = wayIndex.get(wayId);
        if (!w) continue;

        const idx = w.nodes.indexOf(nodeId);
        if (idx < 0) continue;

        // Get the adjacent node to determine direction
        let adjIdx = idx + 1 < w.nodes.length ? idx + 1 : idx - 1;
        if (adjIdx < 0 || adjIdx >= w.nodes.length) continue;
        const adjNodeId = w.nodes[adjIdx];
        const adjLoc = nodeLocations.get(adjNodeId);
        if (!adjLoc) continue;

        const brg = bearing(nodeLoc.lat, nodeLoc.lon, adjLoc.lat, adjLoc.lon);
        approachVectors.push({
          heading: brg,
          roadId: wayId,
          roadName: w.name,
        });
      }

      // Calculate max angle between any pair of approaches
      for (let a = 0; a < approachVectors.length; a++) {
        for (let b = a + 1; b < approachVectors.length; b++) {
          const angle = angleDifference(approachVectors[a].heading, approachVectors[b].heading);
          if (angle > maxAngle) maxAngle = angle;
        }
      }

      // Detailed turn classification
      const numRoads = sharedWays.length;
      turnType = getTurnTypeByRoadCountAndAngle(numRoads, maxAngle);

      // Check for roundabout
      const hasRoundaboutTag = sharedWays.some(wId => {
        const w = wayIndex.get(wId);
        return w && (w.junction === "roundabout" || w.junction === "circular");
      });
      if (hasRoundaboutTag) {
        turnType = sharedWays.length <= 4 ? "mini_roundabout" : "roundabout";
      }

      // Check for slip road
      const hasSlipRoad = sharedWays.some(wId =>
        wayIndex.get(wId)?.highway?.includes("_link")
      );
      if (hasSlipRoad && numRoads >= 2) {
        turnType = "slip_road";
      }

      // Check for offset junction (staggered)
      if (numRoads === 4 && maxAngle < 150) {
        turnType = "offset_junction";
      }

      // Determine max speed limit among approaches
      let maxSpeed = 0;
      for (const wId of sharedWays) {
        const w = wayIndex.get(wId);
        if (w?.maxspeed) {
          const s = parseInt(w.maxspeed, 10);
          if (!isNaN(s) && s > maxSpeed) maxSpeed = s;
        }
      }

      // Determine blind turn (curved + limited sight)
      const isCurved = maxAngle > 30;
      const isBlind = estimateBlind(isCurved, maxSpeed);
      const sightDistance = estimateSightDistance(maxAngle);

      // Check for oneway
      const isOneWay = sharedWays.some(wId =>
        wayIndex.get(wId)?.oneway === "yes"
      );

      // Lane count
      let laneCount = 0;
      for (const wId of sharedWays) {
        const w = wayIndex.get(wId);
        if (w?.lanes) {
          const l = parseInt(w.lanes, 10);
          if (!isNaN(l) && l > laneCount) laneCount = l;
        }
      }

      // Road width
      let roadWidth = 0;
      for (const wId of sharedWays) {
        const w = wayIndex.get(wId);
        if (w?.width) {
          const ww = parseFloat(w.width);
          if (!isNaN(ww) && ww > roadWidth) roadWidth = ww;
        }
      }

      // Risk level calculation
      let riskLevel = 1;
      if (isBlind) riskLevel += 1;
      if (maxAngle > 60) riskLevel += 1;
      if (maxAngle > 90) riskLevel += 1;
      if (numRoads >= 4) riskLevel += 1;
      if (maxSpeed && maxSpeed > 60) riskLevel += 1;
      if (laneCount <= 1) riskLevel += 1;
      riskLevel = Math.min(5, Math.max(1, riskLevel));

      // Road name
      const roadName = sharedWays
        .map(wId => wayIndex.get(wId))
        .find(w => w?.name)
        ?.name || "";

      // Get the turn type string
      let typeStr = turnType;
      // Use the direction-specific type for bends
      if (numRoads === 2 && maxAngle >= 15) {
        // Determine left vs right using the approach vectors
        const h1 = approachVectors[0]?.heading || 0;
        const h2 = approachVectors[1]?.heading || 0;
        let angleDiff = ((h2 - h1) % 360 + 360) % 360;
        if (angleDiff > 180) angleDiff -= 360;
        const isRight = angleDiff > 0;

        if (maxAngle < 30) {
          typeStr = isRight ? "gentle_curve_right" : "gentle_curve_left";
        } else if (maxAngle < 60) {
          typeStr = isRight ? "right" : "left";
        } else if (maxAngle < 90) {
          typeStr = isRight ? "sharp_right" : "sharp_left";
        } else {
          typeStr = isRight ? "hairpin_right" : "hairpin_left";
        }
      }

      turns.push({
        osmId: nodeId,
        location: {
          type: "Point",
          coordinates: [nodeLoc.lon, nodeLoc.lat],
        },
        type: typeStr,
        angle: Math.round(maxAngle),
        riskLevel,
        isBlind,
        junctionCount: numRoads,
        approachVectors,
        speedLimit: maxSpeed || undefined,
        isOneWay: isOneWay || undefined,
        laneCount: laneCount || undefined,
        roadWidth: roadWidth || undefined,
        roadName: roadName || undefined,
        sightDistance,
      });
    }
  }

  console.log(`Found ${turns.length} turns/junctions`);

  // Pass 3: Save roads to Road collection
  console.log("Clearing old roads...");
  await Road.deleteMany({});

  console.log("Importing roads to MongoDB...");
  for (let i = 0; i < ways.length; i += BATCH_SIZE) {
    const batch = ways.slice(i, i + BATCH_SIZE);
    const docs = batch.map((w) => ({
      osmId: w.osmId,
      name: w.name || undefined,
      highway: w.highway,
      nodes: w.nodes,
      geometry: {
        type: "LineString",
        coordinates: w.coordinates,
      },
      oneway: w.oneway || undefined,
      maxspeed: w.maxspeed || undefined,
      ref: w.ref || undefined,
      lanes: w.lanes || undefined,
      width: w.width || undefined,
      surface: w.surface || undefined,
      junction: w.junction || undefined,
    }));
    await Road.insertMany(docs);
    console.log(`  Roads: ${Math.min(i + BATCH_SIZE, ways.length)} / ${ways.length}`);
  }

  // Pass 4: Save turns to Turn collection
  console.log("Clearing old turns...");
  await Turn.deleteMany({});

  if (turns.length > 0) {
    console.log("Importing turns to MongoDB...");
    // FIX ISSUE #35: enum validated before insertMany bypasses Mongoose schema validation
    const validTypes = new Set([
      't_junction', 'cross', 'y_junction', 'offset_junction',
      'roundabout', 'mini_roundabout', 'slip_road',
      'left', 'right', 'sharp_left', 'sharp_right',
      'hairpin_left', 'hairpin_right',
      'slight_left', 'slight_right',
      'gentle_curve_left', 'gentle_curve_right',
      's_curve', 'reverse_s_curve',
      'blind_crest', 'dip', 'narrow_section',
      'dead_end', 'complex', 'straight', 'slight_curve',
      'moderate_turn', 'very_sharp_turn', 'bend',
    ]);
    turns = turns.filter(t => validTypes.has(t.type));
    for (let i = 0; i < turns.length; i += BATCH_SIZE) {
      const batch = turns.slice(i, i + BATCH_SIZE);
      await Turn.insertMany(batch);
      console.log(`  Turns: ${Math.min(i + BATCH_SIZE, turns.length)} / ${turns.length}`);
    }
  }

  // Create indexes
  await Road.collection.createIndex({ geometry: "2dsphere" });
  await Turn.collection.createIndex({ location: "2dsphere" });
  console.log("Indexes created");
  console.log("All done!");

  await mongoose.disconnect();
}

importRoads().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
