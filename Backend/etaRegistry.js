import { EventEmitter } from "events";

class EtaRegistry extends EventEmitter {
  constructor(roadGraph) {
    super();
    this.roadGraph = roadGraph;
    this.junctions = new Map();
    // FIX ISSUE #12: road-indexed junction lookup for O(n) cross-junction checks
    this.junctionsByRoad = new Map(); // roadId → Set<junctionKey>
    this.cleanupInterval = setInterval(() => this._cleanup(), 5000);
    this.pendingConflicts = [];
  }

  getPendingConflicts() {
    const conflicts = [...this.pendingConflicts];
    this.pendingConflicts = [];
    return conflicts;
  }

  update(userId, matched, lat, lng, heading, speed, rawData) {
    if (!matched || !matched.roadId || matched.matchConfidence < 0.3) {
      this._removeVehicle(userId);
      return;
    }

    const junctionsAhead = this.roadGraph.getJunctionsAhead(
      matched.roadId,
      matched.snappedLat || lat,
      matched.snappedLng || lng,
      heading || matched.roadHeading || 0,
      Math.max(50, (speed || 10) * 8)
    );

    const timeSyncQuality = rawData?.timeSyncQuality ?? 1.0;
    const vehicleStateConfidence = matched.vehicleStateConfidence ?? 0.5;

    const now = Date.now();
    let firstJunctionKey = null;
    let firstJunctionEta = Infinity;

    for (const junction of junctionsAhead) {
      if (junction.distance < 1) continue;

      // Spatial merge: round to 3 decimal places (≈110m resolution)
      // Merges nearby junction nodes into one logical junction
      const key = `${Math.round(junction.lat * 1000) / 1000},${Math.round(junction.lng * 1000) / 1000}`;

      if (!this.junctions.has(key)) {
        this.junctions.set(key, {
          lat: junction.lat,
          lng: junction.lng,
          nodeId: junction.nodeId,
          junctionType: junction.junctionType,
          roadId: matched.roadId,
          vehicles: new Map(),
          lastConflictCheck: now,
        });
        // FIX ISSUE #12: register junction under its road for O(1) lookup
        if (!this.junctionsByRoad.has(matched.roadId)) {
          this.junctionsByRoad.set(matched.roadId, new Set());
        }
        this.junctionsByRoad.get(matched.roadId).add(key);
      }

      const entry = this.junctions.get(key);
      const dist = junction.distance;
      // Increase lead time by widening overlap threshold
      const leadTimeBoost = 2.0;
      const eta = speed > 0.5 ? dist / speed : Infinity;
      const clockUncertainty = 1.0 - (1.0 - timeSyncQuality) * 0.5;
      const etaConfidence = vehicleStateConfidence * clockUncertainty * (speed > 0.5 ? 0.9 : 0.3);

      entry.vehicles.set(userId, {
        userId,
        eta,
        distance: dist,
        heading: matched.roadHeading || heading || 0,
        speed,
        fromRoad: matched.roadId,
        approachBearing: junction.approachBearing,
        timestamp: now,
        confidence: etaConfidence,
      });

      if (firstJunctionKey === null) {
        firstJunctionKey = key;
        firstJunctionEta = eta;
      }

      this._checkConflicts(entry, key);
    }

    // Cross-junction check: check vehicles at nearby junctions on the same road
    // FIX ISSUE #12: O(n) not O(n²) via road-indexed lookup
    if (firstJunctionKey && matched.roadId) {
      const sameRoadKeys = this.junctionsByRoad.get(matched.roadId) || new Set();
      const [firstLatStr, firstLngStr] = firstJunctionKey.split(",");
      const firstLatNum = parseFloat(firstLatStr);
      const firstLngNum = parseFloat(firstLngStr);

      for (const otherKey of sameRoadKeys) {
        const otherEntry = this.junctions.get(otherKey);
        if (!otherEntry) continue;
        if (now - (otherEntry.lastConflictCheck || 0) > 10000) continue;

        // Check nearby keys (within ~200m)
        const [oLatStr, oLngStr] = otherKey.split(",");
        const isNearby = otherKey === firstJunctionKey ||
          (Math.abs(parseFloat(oLatStr) - firstLatNum) < 0.002 &&
           Math.abs(parseFloat(oLngStr) - firstLngNum) < 0.002);

        if (!isNearby) continue;

        for (const [otherUid, otherV] of otherEntry.vehicles) {
          if (otherUid === userId) continue;
          if (now - otherV.timestamp > 10000) continue;
          if (otherV.eta === Infinity || firstJunctionEta === Infinity) continue;

          const etaDiff = Math.abs(firstJunctionEta - otherV.eta);
          const combinedConfidence = Math.min(
            vehicleStateConfidence * (speed > 0.5 ? 0.9 : 0.3),
            otherV.confidence
          );
          // Wider threshold for earlier warnings (lead time > 3s)
          const threshold = Math.max(3.0, 5.0 * (1.0 - combinedConfidence * 0.3));

          if (etaDiff <= threshold) {
            const conflictProbability = (1.0 - etaDiff / threshold) * combinedConfidence;
            this.pendingConflicts.push({
              junction: firstJunctionKey,
              junctionLat: 0, junctionLng: 0,
              junctionType: "cross",
              vehicleA: { userId: otherUid, ...otherV },
              vehicleB: { userId, eta: firstJunctionEta },
              etaDiff,
              etaOverlapThreshold: threshold,
              probability: conflictProbability,
              timestamp: now,
            });
          }
        }
      }
    }
  }

  _checkConflicts(entry, junctionKey) {
    const now = Date.now();
    const vehicles = Array.from(entry.vehicles.values()).filter(
      (v) => now - v.timestamp < 10000
    );

    if (vehicles.length < 2) return;

    for (let i = 0; i < vehicles.length; i++) {
      for (let j = i + 1; j < vehicles.length; j++) {
        const a = vehicles[i];
        const b = vehicles[j];

        if (a.eta === Infinity || b.eta === Infinity) continue;

        const etaDiff = Math.abs(a.eta - b.eta);
        const combinedConfidence = Math.min(a.confidence, b.confidence);
        // Wider threshold for earlier warnings (lead time > 3s)
        const etaOverlapThreshold = Math.max(3.0, 5.0 * (1.0 - combinedConfidence * 0.3));
        const maxSpeed = Math.max(a.speed, b.speed);
        const etaErrorMargin = maxSpeed > 15 ? etaDiff * 1.2 : etaDiff * 1.5;

        if (etaErrorMargin <= etaOverlapThreshold) {
          const baseProbability = 1.0 - (etaErrorMargin / etaOverlapThreshold);
          const conflictProbability = baseProbability * combinedConfidence;

          const conflict = {
            junction: junctionKey,
            junctionLat: entry.lat,
            junctionLng: entry.lng,
            junctionType: entry.junctionType,
            vehicleA: { ...a },
            vehicleB: { ...b },
            etaDiff,
            etaOverlapThreshold,
            probability: conflictProbability,
            timestamp: now,
          };

          console.log(`🚦 ETA conflict: ${a.userId} (ETA=${a.eta.toFixed(1)}s) vs ${b.userId} (ETA=${b.eta.toFixed(1)}s) prob=${conflictProbability.toFixed(2)}`);
          this.pendingConflicts.push(conflict);
          this.emit("junctionConflict", conflict);
        }
      }
    }
  }

  _removeVehicle(userId) {
    for (const [, entry] of this.junctions) {
      entry.vehicles.delete(userId);
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.junctions) {
      for (const [userId, vehicle] of entry.vehicles) {
        if (now - vehicle.timestamp > 10000) {
          entry.vehicles.delete(userId);
        }
      }
      if (entry.vehicles.size === 0) {
        this.junctions.delete(key);
      }
    }
  }

  getJunctionsForUser(userId) {
    const result = [];
    for (const [key, entry] of this.junctions) {
      if (entry.vehicles.has(userId)) {
        result.push({
          key,
          lat: entry.lat,
          lng: entry.lng,
          junctionType: entry.junctionType,
          vehicles: Array.from(entry.vehicles.values()),
        });
      }
    }
    return result;
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.junctions.clear();
    this.removeAllListeners();
  }
}

export default EtaRegistry;
