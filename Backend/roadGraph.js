import Road from "./Models/Road.Model.js";

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getBearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function normalizeAngleDeg(a) {
  return ((a % 360) + 360) % 360;
}

function _classifyJunctionShape(dirs, totalConnected, maxAngleDiff) {
  if (dirs.includes("straight") && dirs.length >= 2) return "cross";
  if (dirs.length >= 2 && !dirs.includes("straight")) return "y_junction";
  if (dirs.length === 0) return "straight";
  if (dirs.length === 1) return "single";
  return "complex";
}

class RoadGraph {
  constructor() {
    this.adjacency = new Map();
    this.roadData = new Map();
    this.nodeToRoads = new Map();
    this.roadConfidence = new Map();
    this.roadSegments = new Map();
    this.initialized = false;
  }

  async loadFromMongo() {
    console.log("🗺️ Loading road graph from MongoDB...");

    try {
      const HYDERABAD_REGION = {
        $geoWithin: {
          $geometry: {
            type: "Polygon",
            coordinates: [[
              [78.500, 17.315],
              [78.620, 17.315],
              [78.620, 17.448],
              [78.500, 17.448],
              [78.500, 17.315],
            ]]
          }
        }
      };
      const roads = await Road.find({ geometry: HYDERABAD_REGION }, {
        osmId: 1, highway: 1, name: 1, nodes: 1, geometry: 1,
        oneway: 1, maxspeed: 1, lanes: 1, ref: 1, width: 1, surface: 1, junction: 1,
        osmAgeDays: 1,
      }).lean();
      console.log(`📦 Loaded ${roads.length} roads`);

      for (const road of roads) {
        const osmId = road.osmId;
        if (!osmId) continue;

        this.roadData.set(osmId, road);

        const nodes = road.nodes || [];
        const coords = road.geometry?.coordinates || [];
        const segments = [];

        for (let i = 0; i < nodes.length && i < coords.length - 1; i++) {
          const nodeId = nodes[i];
          const nextNodeId = nodes[i + 1];
          const [lon1, lat1] = coords[i];
          const [lon2, lat2] = coords[i + 1];

          segments.push({
            startNode: nodeId,
            endNode: nextNodeId,
            startLat: lat1,
            startLon: lon1,
            endLat: lat2,
            endLon: lon2,
            length: haversineMeters(lat1, lon1, lat2, lon2),
            bearing: getBearing(lat1, lon1, lat2, lon2),
          });

          if (!this.nodeToRoads.has(nodeId)) this.nodeToRoads.set(nodeId, new Set());
          this.nodeToRoads.get(nodeId).add(osmId);

          if (!this.nodeToRoads.has(nextNodeId)) this.nodeToRoads.set(nextNodeId, new Set());
          this.nodeToRoads.get(nextNodeId).add(osmId);
        }

        this.roadSegments.set(osmId, segments);
        this.roadConfidence.set(osmId, this._computeRoadConfidence(road));
      }
    } catch (err) {
      console.error("❌ Road query failed:", err.message);
    }

    for (const [nodeId, roadIds] of this.nodeToRoads) {
      const roadsArr = Array.from(roadIds);
      for (const r1 of roadsArr) {
        if (!this.adjacency.has(r1)) this.adjacency.set(r1, new Map());
        for (const r2 of roadsArr) {
          if (r1 !== r2) {
            const current = this.adjacency.get(r1).get(r2);
            this.adjacency.get(r1).set(r2, (current || 0) + 1);
          }
        }
      }
    }

    console.log(`🗺️ Road graph built: ${this.roadData.size} roads, ${this.nodeToRoads.size} nodes`);
    this.initialized = true;
  }

  _computeRoadConfidence(road) {
    let c = 1.0;
    const ageDays = road.osmAgeDays;
    if (ageDays !== undefined) {
      if (ageDays > 365 * 3) c *= 0.7;
      else if (ageDays > 365) c *= 0.85;
      else if (ageDays > 30) c *= 0.95;
    }
    const highway = road.highway;
    if (highway === "construction") c *= 0.5;
    if (highway === "proposed") c *= 0.3;
    if (highway === "motorway" || highway === "trunk" || highway === "primary") c *= 1.0;
    return Math.max(0.1, Math.min(1.0, c));
  }

  getRoad(osmId) {
    return this.roadData.get(osmId) || null;
  }

  getRoadConfidence(osmId) {
    return this.roadConfidence.get(osmId) ?? 0.5;
  }

  getConnectedRoads(osmId) {
    const adj = this.adjacency.get(osmId);
    return adj ? Array.from(adj.keys()) : [];
  }

  areRoadsConnected(roadA, roadB, maxHops = 3) {
    if (roadA === roadB) return true;
    const visited = new Set();
    const queue = [[roadA, 0]];
    visited.add(roadA);
    while (queue.length > 0) {
      const [current, depth] = queue.shift();
      if (depth >= maxHops) continue;
      const neighbors = this.adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors.keys()) {
        if (neighbor === roadB) return true;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push([neighbor, depth + 1]);
        }
      }
    }
    return false;
  }

  getReachableRoads(startRoadId, maxDistanceMeters, speedMs, startHeading) {
    if (!this.initialized || !startRoadId) return [];

    const maxDurationS = maxDistanceMeters / Math.max(speedMs, 0.1);
    const horizonMeters = Math.min(maxDistanceMeters, speedMs * Math.min(maxDurationS, 12));

    const visited = new Set();
    const result = [];

    const entryDist = this._getDistanceToEnd(startRoadId, startHeading);
    if (entryDist > 0) {
      const remainingAfterEntry = horizonMeters - entryDist;
      result.push({
        roadId: startRoadId,
        entryHeading: startHeading,
        exitHeading: this._getRoadEndBearing(startRoadId, startHeading),
        distanceOnRoad: entryDist,
        cumulativeDist: entryDist,
        remainingDist: remainingAfterEntry,
      });
      if (remainingAfterEntry <= 0) return result;

      const exitNodeId = this._getExitNodeId(startRoadId, startHeading);
      if (exitNodeId === null) return result;

      const queue = [{ roadId: startRoadId, nodeId: exitNodeId, cumulativeDist: entryDist, prevRoad: null }];
      visited.add(`${startRoadId}-${exitNodeId}`);

      while (queue.length > 0) {
        const current = queue.shift();
        const connected = this._getConnectedRoadsViaNode(current.roadId, current.nodeId);
        for (const nextRoadId of connected) {
          if (nextRoadId === current.prevRoad) continue;
          const key = `${nextRoadId}-${current.nodeId}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const roadLen = this._getRoadLength(nextRoadId);
          const newCumulative = current.cumulativeDist + roadLen;
          const entryBearing = this._getRoadEntryBearing(nextRoadId, current.nodeId);
          const exitBearing = this._getRoadEndBearing(nextRoadId, entryBearing);
          result.push({
            roadId: nextRoadId,
            entryHeading: entryBearing,
            exitHeading: exitBearing,
            distanceOnRoad: roadLen,
            cumulativeDist: newCumulative,
            remainingDist: horizonMeters - newCumulative,
          });
          if (newCumulative < horizonMeters) {
            const exitNode = this._getExitNodeId(nextRoadId, entryBearing);
            if (exitNode !== null) {
              queue.push({ roadId: nextRoadId, nodeId: exitNode, cumulativeDist: newCumulative, prevRoad: current.roadId });
            }
          }
        }
      }
    }
    return result;
  }

  getJunctionsAhead(roadId, lat, lng, heading, scanDistanceM) {
    if (!this.initialized || !roadId) return [];

    const road = this.roadData.get(roadId);
    if (!road) return [];

    const coords = road.geometry?.coordinates || [];
    const nodes = road.nodes || [];
    if (coords.length < 2) return [];

    const junctions = [];
    const roadDir = this._getBestHeadingForRoad(road, heading);
    const goingForward = Math.abs(normalizeAngleDeg(heading) - normalizeAngleDeg(roadDir)) <= 90;
    const startIdx = this._findClosestNodeIndex(lat, lng, coords);
    const step = goingForward ? 1 : -1;

    let cumulativeDist = 0;
    for (let i = startIdx; goingForward ? i < nodes.length - 1 : i > 0; i += step) {
      const nodeId = nodes[i];
      const [clon, clat] = coords[i];
      if (i !== startIdx) {
        const [plon, plat] = coords[i - step];
        cumulativeDist += haversineMeters(plat, plon, clat, clon);
      }
      if (cumulativeDist > scanDistanceM) break;

      const connectedRoads = this.nodeToRoads.get(nodeId);
      if (connectedRoads && connectedRoads.size > 1) {
        const bearingToJunction = getBearing(lat, lng, clat, clon);

        // Compute direction of each connecting road relative to approach
        const dirs = [];
        let maxAngleDiff = 0;
        for (const otherId of connectedRoads) {
          if (otherId === roadId) continue;
          const otherBearing = this._getRoadEntryBearing(otherId, nodeId);
          let diff = (otherBearing - bearingToJunction) % 360;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;

          if (Math.abs(diff) > Math.abs(maxAngleDiff)) maxAngleDiff = diff;

          if (Math.abs(diff) <= 30) dirs.push("straight");
          else if (diff > 30) dirs.push("right");
          else if (diff < -30) dirs.push("left");
        }

        const absAngle = Math.abs(maxAngleDiff);
        const dir = maxAngleDiff > 0 ? "right" : "left";
        let turnType = _classifyJunctionShape(dirs, connectedRoads.size, maxAngleDiff);
        if (turnType === "single") {
          if (absAngle > 150) turnType = `hairpin_${dir}`;
          else if (absAngle > 90) turnType = `sharp_${dir}`;
          else if (absAngle > 30) turnType = `${dir}_turn`;
          else turnType = `slight_${dir}`;
        }

        const riskLevel = absAngle < 15 ? 0 : absAngle < 30 ? 1 : absAngle < 60 ? 2 : absAngle < 90 ? 3 : absAngle < 150 ? 4 : 5;

        junctions.push({
          nodeId,
          lat: clat,
          lng: clon,
          distance: cumulativeDist,
          connectedRoads: Array.from(connectedRoads),
          approachBearing: bearingToJunction,
          junctionType: this._classifyJunction(connectedRoads, roadId, heading, clat, clon),
          dirs,
          angle: maxAngleDiff,
          turnType,
          riskLevel,
        });
      }
    }

    return junctions;
  }

  getRoadSegments(osmId) {
    return this.roadSegments.get(osmId) || [];
  }

  getRoadLength(osmId) {
    const segments = this.roadSegments.get(osmId);
    if (!segments) return 0;
    return segments.reduce((sum, s) => sum + s.length, 0);
  }

  getRoadHeadingAtPoint(roadId, lat, lng) {
    const road = this.roadData.get(roadId);
    if (!road || !road.geometry?.coordinates) return null;
    const coords = road.geometry.coordinates;
    let minDist = Infinity;
    let bestBearing = 0;
    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const d = haversineMeters(lat, lng, (lat1 + lat2) / 2, (lon1 + lon2) / 2);
      if (d < minDist) {
        minDist = d;
        bestBearing = getBearing(lat1, lon1, lat2, lon2);
      }
    }
    return bestBearing;
  }

  getTrajectory(roadId, lat, lng, heading, speed, horizonSeconds) {
    if (!this.initialized || !roadId) return null;
    const road = this.roadData.get(roadId);
    if (!road || !road.geometry?.coordinates || road.geometry.coordinates.length < 2) return null;

    const coords = road.geometry.coordinates;
    const startIdx = this._findClosestNodeIndex(lat, lng, coords);

    // Determine travel direction based on heading vs road direction
    const roadBearing = getBearing(
      coords[startIdx][1], coords[startIdx][0],
      startIdx + 1 < coords.length ? coords[startIdx + 1][1] : coords[startIdx][1],
      startIdx + 1 < coords.length ? coords[startIdx + 1][0] : coords[startIdx][0]
    );
    const goingForward = Math.abs(normalizeAngleDeg(heading) - normalizeAngleDeg(roadBearing)) <= 90;

    // Walk along road geometry, generating trajectory points
    const trajectory = [];
    const stepS = 0.5;
    const totalSteps = Math.ceil(horizonSeconds / stepS);
    const totalDist = speed * horizonSeconds;

    let accumulatedDist = 0;
    let prevLat = coords[startIdx][1];
    let prevLon = coords[startIdx][0];

    for (let step = 1; step <= totalSteps; step++) {
      const targetDist = speed * step * stepS;
      let found = false;

      // Walk geometry segments until we reach target distance
      let segDist = 0;
      let currentLat = prevLat;
      let currentLon = prevLon;

      if (goingForward) {
        for (let i = startIdx; i < coords.length - 1; i++) {
          const [lon1, lat1] = coords[i];
          const [lon2, lat2] = coords[i + 1];
          const segLen = haversineMeters(lat1, lon1, lat2, lon2);

          if (segDist + segLen >= targetDist - accumulatedDist) {
            const frac = (targetDist - accumulatedDist - segDist) / segLen;
            currentLat = lat1 + (lat2 - lat1) * frac;
            currentLon = lon1 + (lon2 - lon1) * frac;
            found = true;
            break;
          }
          segDist += segLen;
          if (i === startIdx) {
            currentLat = lat2;
            currentLon = lon2;
          } else {
            currentLat = lat2;
            currentLon = lon2;
          }
        }
        if (!found && coords.length > 0) {
          const last = coords[coords.length - 1];
          currentLat = last[1];
          currentLon = last[0];
        }
      } else {
        for (let i = startIdx; i > 0; i--) {
          const [lon1, lat1] = coords[i];
          const [lon2, lat2] = coords[i - 1];
          const segLen = haversineMeters(lat1, lon1, lat2, lon2);

          if (segDist + segLen >= targetDist - accumulatedDist) {
            const frac = (targetDist - accumulatedDist - segDist) / segLen;
            currentLat = lat1 + (lat2 - lat1) * frac;
            currentLon = lon1 + (lon2 - lon1) * frac;
            found = true;
            break;
          }
          segDist += segLen;
          currentLat = lat2;
          currentLon = lon2;
        }
        if (!found && coords.length > 0) {
          currentLat = coords[0][1];
          currentLon = coords[0][0];
        }
      }

      trajectory.push({
        lat: currentLat,
        lng: currentLon,
        t: step * stepS,
      });

      prevLat = currentLat;
      prevLon = currentLon;
    }

    return trajectory;
  }

  projectToRoad(lat, lng, roadId) {
    const road = this.roadData.get(roadId);
    if (!road || !road.geometry?.coordinates) return null;

    const coords = road.geometry.coordinates;
    let minDist = Infinity;
    let projected = { lat, lng };
    let heading = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const [lon1, lat1] = coords[i];
      const [lon2, lat2] = coords[i + 1];
      const projectedPoint = this._projectToSegment(lat, lng, lat1, lon1, lat2, lon2);
      const d = haversineMeters(lat, lng, projectedPoint.lat, projectedPoint.lng);
      if (d < minDist) {
        minDist = d;
        projected = projectedPoint;
        heading = getBearing(lat1, lon1, lat2, lon2);
      }
    }

    return { lat: projected.lat, lng: projected.lng, heading, distanceToRoad: minDist };
  }

  _projectToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
    const metersPerDegLat = 111320;
    const cosLat = Math.cos((pLat * Math.PI) / 180);
    const metersPerDegLon = metersPerDegLat * Math.max(cosLat, 0.01);

    const ax = aLng * metersPerDegLon;
    const ay = aLat * metersPerDegLat;
    const bx = bLng * metersPerDegLon;
    const by = bLat * metersPerDegLat;
    const px = pLng * metersPerDegLon;
    const py = pLat * metersPerDegLat;

    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby;

    if (ab2 < 0.01) return { lat: aLat, lng: aLng };

    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));

    return {
      lat: (ay + t * aby) / metersPerDegLat,
      lng: (ax + t * abx) / metersPerDegLon,
    };
  }

  _getRoadLength(osmId) {
    return this.getRoadLength(osmId);
  }

  _findClosestNodeIndex(lat, lng, coords) {
    let minDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < coords.length; i++) {
      const [lon, clat] = coords[i];
      const d = haversineMeters(lat, lng, clat, lon);
      if (d < minDist) {
        minDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  _getDistanceToEnd(roadId, heading) {
    const segments = this.roadSegments.get(roadId);
    if (!segments || segments.length === 0) return 0;
    const roadDir = this._getRoadEndBearing(roadId, heading);
    const goingForward = Math.abs(normalizeAngleDeg(heading) - normalizeAngleDeg(roadDir)) <= 90;
    if (goingForward) return segments.reduce((sum, s) => sum + s.length, 0) * 0.5;
    return segments.reduce((sum, s) => sum + s.length, 0) * 0.5;
  }

  _getRoadEndBearing(roadId, entryHeading) {
    const segments = this.roadSegments.get(roadId);
    if (!segments || segments.length === 0) return entryHeading;
    const roadDir = segments[Math.floor(segments.length / 2)]?.bearing || entryHeading;
    if (Math.abs(normalizeAngleDeg(entryHeading) - normalizeAngleDeg(roadDir)) <= 90) return roadDir;
    return normalizeAngleDeg(roadDir + 180);
  }

  _getRoadEntryBearing(roadId, entryNodeId) {
    const segments = this.roadSegments.get(roadId);
    if (!segments) return 0;
    for (const s of segments) {
      if (s.startNode === entryNodeId) return s.bearing;
      if (s.endNode === entryNodeId) return normalizeAngleDeg(s.bearing + 180);
    }
    return segments[0]?.bearing || 0;
  }

  _getExitNodeId(roadId, entryHeading) {
    const segments = this.roadSegments.get(roadId);
    if (!segments || segments.length === 0) return null;
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    const firstBearing = firstSeg.bearing;
    const goingForward = Math.abs(normalizeAngleDeg(entryHeading) - normalizeAngleDeg(firstBearing)) <= 90;
    return goingForward ? lastSeg.endNode : firstSeg.startNode;
  }

  _getConnectedRoadsViaNode(roadId, nodeId) {
    const roadsAtNode = this.nodeToRoads.get(nodeId);
    if (!roadsAtNode) return [];
    return Array.from(roadsAtNode).filter((id) => id !== roadId);
  }

  _getBestHeadingForRoad(road, vehicleHeading) {
    const coords = road.geometry?.coordinates;
    if (!coords || coords.length < 2) return vehicleHeading;
    const [lon1, lat1] = coords[0];
    const [lon2, lat2] = coords[1];
    const roadBearing = getBearing(lat1, lon1, lat2, lon2);
    if (Math.abs(normalizeAngleDeg(vehicleHeading) - normalizeAngleDeg(roadBearing)) <= 90) return roadBearing;
    return normalizeAngleDeg(roadBearing + 180);
  }

  _classifyJunction(connectedRoads, currentRoadId, heading, lat, lng) {
    const count = connectedRoads.size;
    if (count <= 2) return "bend";
    if (count === 3) {
      const roads = Array.from(connectedRoads).filter((id) => id !== currentRoadId);
      if (roads.length === 2) {
        const b1 = this._getRoadEntryBearing(roads[0], this._findNodeIdForRoad(lat, lng, roads[0]));
        const b2 = this._getRoadEntryBearing(roads[1], this._findNodeIdForRoad(lat, lng, roads[1]));
        const diff = Math.abs(normalizeAngleDeg(b1) - normalizeAngleDeg(b2));
        if (diff < 45) return "y_junction";
        return "t_junction";
      }
      return "t_junction";
    }
    if (count === 4) return "cross";
    return "complex";
  }

  _findNodeIdForRoad(lat, lng, roadId) {
    const road = this.roadData.get(roadId);
    if (!road || !road.geometry?.coordinates) return null;
    const coords = road.geometry.coordinates;
    let minDist = Infinity;
    let bestNode = null;
    for (let i = 0; i < coords.length; i++) {
      const [lon, clat] = coords[i];
      const d = haversineMeters(lat, lng, clat, lon);
      if (d < minDist) {
        minDist = d;
        bestNode = road.nodes ? road.nodes[i] : null;
      }
    }
    return bestNode;
  }
}

export default RoadGraph;
