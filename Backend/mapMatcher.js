import Road from "./Models/Road.Model.js";

const MAX_MATCH_DISTANCE_M = 50;
const MAX_MATCH_WITH_UNCERTAINTY_M = 80;

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

function normalizeAngleDeg(a) {
  return ((a % 360) + 360) % 360;
}

function bearingDiff(a, b) {
  let d = Math.abs(normalizeAngleDeg(a) - normalizeAngleDeg(b));
  if (d > 180) d = 360 - d;
  return d;
}

class MapMatcher {
  constructor(roadGraph) {
    this.roadGraph = roadGraph;
    this.vehicleState = new Map();
  }

  async match(userId, lat, lng, heading, speed, positionUncertainty, timestamp) {
    const prevState = this.vehicleState.get(userId) || null;
    const effectiveRadius = Math.min(
      Math.max(positionUncertainty || 15, MAX_MATCH_DISTANCE_M),
      MAX_MATCH_WITH_UNCERTAINTY_M + (speed || 0) * 2
    );

    // Backend outlier rejection: if position jumped impossibly far, use predicted position
    let effectiveLat = lat;
    let effectiveLng = lng;
    if (prevState && prevState.lat !== undefined && prevState.lat !== null) {
      const timeDelta = (timestamp || Date.now()) - (prevState.timestamp || 0);
      const maxTravelM = Math.max((prevState.speed || 0) * (timeDelta / 1000) * 1.5 + 30, 40);
      const distFromPrev = haversineMeters(prevState.lat, prevState.lng, lat, lng);
      if (distFromPrev > maxTravelM) {
        // Reject as outlier, predict position from previous state
        const dt = Math.max(timeDelta / 1000, 0.5);
        const hRad = (prevState.heading || 0) * Math.PI / 180;
        effectiveLat = prevState.lat + (prevState.speed || 0) * dt * Math.cos(hRad) / 111320;
        effectiveLng = prevState.lng + (prevState.speed || 0) * dt * Math.sin(hRad) / (111320 * Math.cos(prevState.lat * Math.PI / 180));
        console.log(`🚫 Outlier rejected for ${userId}: jumped ${distFromPrev.toFixed(0)}m, max allowed ${maxTravelM.toFixed(0)}m`);
      }
    }

    // Fast spatial query using MongoDB 2dsphere index
    const nearbyRoads = await Road.find({
      geometry: {
        $near: {
          $geometry: { type: "Point", coordinates: [effectiveLng, effectiveLat] },
          $maxDistance: effectiveRadius,
        },
      },
    }).limit(15).maxTimeMS(5000).lean();

    if (!nearbyRoads || nearbyRoads.length === 0) {
      return this._noMatch(userId, effectiveLat, effectiveLng, heading, speed, positionUncertainty, prevState);
    }

    const candidates = [];
    for (const road of nearbyRoads) {
      const score = this._scoreCandidate(road, effectiveLat, effectiveLng, heading, speed, prevState, positionUncertainty);
      const projected = this.roadGraph.projectToRoad(effectiveLat, effectiveLng, road.osmId);
      candidates.push({
        road,
        score,
        projected,
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    if (!best || best.score < 0.25) {
      return this._noMatch(userId, lat, lng, heading, speed, positionUncertainty, prevState);
    }

    const matchConfidence = Math.min(1.0, best.score);

    const snapped = best.projected || { lat: effectiveLat, lng: effectiveLng, heading: 0, distanceToRoad: 0 };

    const result = {
      matched: true,
      roadId: best.road.osmId,
      roadName: best.road.name || null,
      highway: best.road.highway || null,
      snappedLat: snapped.lat,
      snappedLng: snapped.lng,
      roadHeading: snapped.heading || this.roadGraph.getRoadHeadingAtPoint(best.road.osmId, snapped.lat, snapped.lng) || heading,
      matchConfidence,
      distanceToRoad: snapped.distanceToRoad || haversineMeters(effectiveLat, effectiveLng, snapped.lat, snapped.lng),
      oneway: best.road.oneway || null,
      maxspeed: best.road.maxspeed || null,
      lanes: best.road.lanes || null,
      roadConfidence: this.roadGraph.getRoadConfidence(best.road.osmId),
      vehicleStateConfidence: this._computeVehicleStateConfidence(matchConfidence, positionUncertainty, speed),
    };

    this.vehicleState.set(userId, {
      roadId: result.roadId,
      lat: effectiveLat,
      lng: effectiveLng,
      heading,
      speed,
      matchConfidence,
      timestamp,
    });

    return result;
  }

  _scoreCandidate(road, lat, lng, heading, speed, prevState, positionUncertainty) {
    const roadConfidence = this.roadGraph.getRoadConfidence(road.osmId);

    const projected = this.roadGraph.projectToRoad(lat, lng, road.osmId);
    if (!projected) return 0;

    const distToRoad = projected.distanceToRoad;
    const distScore = 1.0 - Math.min(distToRoad / MAX_MATCH_DISTANCE_M, 1);

    const roadHeading = this.roadGraph.getRoadHeadingAtPoint(road.osmId, lat, lng) || projected.heading;
    const hdgDiff = bearingDiff(heading || 0, roadHeading);
    const headingScore = 1.0 - Math.min(hdgDiff / 90, 1);

    let continuityScore = 0.35;
    if (prevState && prevState.roadId === road.osmId) {
      continuityScore = 1.0;
    } else if (prevState && prevState.roadId) {
      const connected = this.roadGraph.areRoadsConnected(prevState.roadId, road.osmId, 1);
      continuityScore = connected ? 0.7 : 0.25;
    }

    // Base score without uncertainty penalty
    let score = distScore * 0.35 + headingScore * 0.25 + continuityScore * 0.20 + roadConfidence * 0.20;

    // Penalties
    if (speed > 5 && distToRoad > 20) {
      score -= (distToRoad - 20) / 200;
    }
    if (road.highway === "motorway" || road.highway === "trunk") {
      if (speed > 10) score += 0.05;
    }

    // Position uncertainty reduces confidence slightly
    const posUncertaintyWeight = Math.max(0.85, 1.0 - (positionUncertainty || 10) / 100);
    score *= posUncertaintyWeight;

    return Math.max(0, Math.min(1.0, score));
  }

  _noMatch(userId, lat, lng, heading, speed, positionUncertainty, prevState) {
    const result = {
      matched: false,
      roadId: null,
      roadName: null,
      highway: null,
      snappedLat: lat,
      snappedLng: lng,
      roadHeading: heading,
      matchConfidence: 0,
      distanceToRoad: null,
      oneway: null,
      maxspeed: null,
      lanes: null,
      roadConfidence: 0,
      vehicleStateConfidence: this._computeVehicleStateConfidence(0, positionUncertainty, speed),
    };

    if (prevState && prevState.roadId) {
      const timeSinceLastMatch = Date.now() - (prevState.timestamp || 0);
      if (timeSinceLastMatch < 5000) {
        result.roadId = prevState.roadId;
        result.matchConfidence = Math.max(0, prevState.matchConfidence * (1 - timeSinceLastMatch / 5000));
        if (result.matchConfidence > 0.3) {
          result.roadConfidence = this.roadGraph.getRoadConfidence(prevState.roadId);
        }
      }
    }

    this.vehicleState.set(userId, {
      roadId: result.roadId,
      lat,
      lng,
      heading,
      speed,
      matchConfidence: result.matchConfidence,
      timestamp: Date.now(),
    });

    return result;
  }

  _computeVehicleStateConfidence(matchConfidence, positionUncertainty, speed) {
    let c = 0.5;
    c += matchConfidence * 0.3;
    if (positionUncertainty !== undefined) {
      c += Math.max(0, 1 - positionUncertainty / 40) * 0.2;
    }
    if (speed !== undefined && speed > 1) {
      c += 0.1;
    }
    return Math.max(0.1, Math.min(1.0, c));
  }

  getStaleness(lastTimestamp) {
    if (!lastTimestamp) return "expired";
    const age = Date.now() - lastTimestamp;
    if (age < 2000) return "fresh";
    if (age < 5000) return "degraded";
    if (age < 10000) return "stale";
    return "expired";
  }
}

export default MapMatcher;
