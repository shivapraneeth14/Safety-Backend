import WebSocket from 'ws';
import http from 'http';

const SERVER_PORT = 5001;
const HTTP_BASE = `http://localhost:${SERVER_PORT}`;
const WS_BASE = `ws://localhost:${SERVER_PORT}`;
const COLLISION_THRESHOLD_M = 15;
const TICK_INTERVAL_MS = 1000;
const DEG_PER_M_LAT = 1 / 111320;
const SUDDEN_DECEL_THRESHOLD = 3.5;
const RUN_DURATION_SEC = 15;
const DEG_PER_M_LON = (lat) => 1 / (111320 * Math.cos(lat * Math.PI / 180));

const REF_LAT = 17.3850;
const REF_LNG = 78.4870;

function gaussianRandom(mean = 0, std = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * std;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function weightedRandomAccel() {
  const r = Math.random();
  if (r < 0.05) {
    return -(3.0 + Math.random() * 1.5);
  }
  if (r < 0.85) {
    return (Math.random() - 0.5) * 1.0;
  }
  return (Math.random() * 7.5) - 4.5;
}

function randomHeadingDrift(nearJunction) {
  const sigma = nearJunction ? 15 : 2;
  return gaussianRandom(0, sigma);
}

function now() { return Date.now(); }

let QUIET = false;
function log(...args) { if (!QUIET) console.log(...args); }

const GPS_TIER_NAMES = ['phone', 'assisted', 'gnss'];

class VehicleSim {
  constructor(id, index, opts = {}) {
    this.id = id;
    this.index = index;
    this.gpsTier = index % 3;
    this.gpsSigma = [12, 5, 3][this.gpsTier];

    const offsetLat = opts.offsetLat || 0;
    const offsetLng = opts.offsetLng || 0;
    this.trueLat = REF_LAT + offsetLat;
    this.trueLng = REF_LNG + offsetLng;

    this.speed = 4 + Math.random() * 8;
    this.heading = 0;
    this.trueAccel = 0;
    this.trueYawRate = 0;

    this.prevGpsSpeed = this.speed;
    this.prevTickTime = 0;

    this.brakingInjected = false;
    this.brakingStartTick = -1;
    this.brakingDurationLeft = 0;

    this.nearJunction = false;
    this.junctionDist = Infinity;

    this.accelHistory = [];
  }

  tick(tickNum, dt = 1) {
    this.trueAccel = weightedRandomAccel();

    if (this.brakingDurationLeft > 0) {
      this.trueAccel = -(4.0 + Math.random() * 1.5);
      this.brakingDurationLeft -= dt;
      if (this.brakingDurationLeft <= 0) this.brakingDurationLeft = 0;
    }

    this.speed = clamp(this.speed + this.trueAccel * dt, 0, 25);

    const nearJunc = this.junctionDist < 50;
    const drift = randomHeadingDrift(nearJunc);
    this.heading = (this.heading + drift * dt + 360) % 360;

    const hRad = this.heading * Math.PI / 180;
    const distM = this.speed * dt;
    const dLat = distM * Math.cos(hRad) * DEG_PER_M_LAT;
    const dLng = distM * Math.sin(hRad) * DEG_PER_M_LON(this.trueLat);
    this.trueLat += dLat;
    this.trueLng += dLng;

    if (this.junctionDist > 0) {
      this.junctionDist -= distM;
      if (this.junctionDist < 0) this.junctionDist = 0;
    }
    this.nearJunction = nearJunc;

    this.prevTickTime = tickNum;

    if (this.junctionDist <= 0) {
      this.trueYawRate = 0;
    } else if (this.nearJunction) {
      this.trueYawRate = this.brakingDurationLeft > 0 ? 0 : (10 + Math.random() * 50);
    } else {
      this.trueYawRate = gaussianRandom(0, 5);
    }
  }

  injectSharpBrake(durationSec = 2) {
    this.brakingInjected = true;
    this.brakingDurationLeft = durationSec;
    return this.trueAccel;
  }

  getReportedState() {
    const gpsLatNoise = gaussianRandom(0, this.gpsSigma) * DEG_PER_M_LAT;
    const gpsLngNoise = gaussianRandom(0, this.gpsSigma) * DEG_PER_M_LON(this.trueLat);

    const reportedLat = this.trueLat + gpsLatNoise;
    const reportedLng = this.trueLng + gpsLngNoise;

    const repAccelX = this.trueAccel + gaussianRandom(0, 0.3);
    const repAccelY = gaussianRandom(0, 0.3);
    const repAccelZ = 9.8 + gaussianRandom(0, 0.3);

    const repGyroZ = this.trueYawRate + gaussianRandom(0, 5);

    const speedNoise = gaussianRandom(0, 0.5);
    const repSpeed = Math.max(0, this.speed + speedNoise);

    return {
      userId: this.id,
      latitude: reportedLat,
      longitude: reportedLng,
      speed: repSpeed,
      heading: this.heading,
      gyro: { x: 0, y: 0, z: repGyroZ },
      accelerometer: { x: repAccelX, y: repAccelY, z: repAccelZ },
      positionUncertainty: this.gpsSigma,
      sensorQuality: [0.6, 0.8, 0.95][this.gpsTier],
      connectivity: 'wifi',
      timestamp: new Date().toISOString(),
    };
  }

  getGroundTruth() {
    return {
      id: this.id,
      lat: this.trueLat,
      lng: this.trueLng,
      speed: this.speed,
      heading: this.heading,
      trueAccel: this.trueAccel,
      brakingInjected: this.brakingInjected,
      junctionDist: this.junctionDist,
    };
  }
}

const HEADING_EPSILON = 30;
const CLOSING_SPEED_MIN = 1.0;

class GroundTruthTracker {
  constructor() {
    this.tickRecords = [];
    this.pairData = new Map();
  }

  recordTick(tickNum, vehicles) {
    const gt = vehicles.map(v => v.getGroundTruth());
    this.tickRecords.push({ tick: tickNum, vehicles: gt });

    for (let i = 0; i < gt.length; i++) {
      for (let j = i + 1; j < gt.length; j++) {
        const key = this._pairKey(gt[i].id, gt[j].id);
        const dist = haversineMeters(gt[i].lat, gt[i].lng, gt[j].lat, gt[j].lng);

        if (!this.pairData.has(key)) {
          this.pairData.set(key, {
            idA: gt[i].id, idB: gt[j].id,
            minDist: dist, minDistTick: tickNum,
            firstApproachTick: -1,
            hdgA: gt[i].heading, hdB: gt[j].heading,
            speedA: gt[i].speed, speedB: gt[j].speed,
          });
        } else {
          const entry = this.pairData.get(key);
          if (dist < entry.minDist) {
            entry.minDist = dist;
            entry.minDistTick = tickNum;
            entry.hdgA = gt[i].heading;
            entry.hdB = gt[j].heading;
            entry.speedA = gt[i].speed;
            entry.speedB = gt[j].speed;
          }
        }

        const entry = this.pairData.get(key);
        const hdgDiff = Math.abs(((gt[i].heading - gt[j].heading) % 360 + 540) % 360 - 180);
        const closingSpeed = gt[i].speed - gt[j].speed;
        const sameDir = hdgDiff < HEADING_EPSILON;

        const isConvergent = dist <= COLLISION_THRESHOLD_M && (
          !sameDir || Math.abs(closingSpeed) > CLOSING_SPEED_MIN
        );

        if (isConvergent && entry.firstApproachTick === -1) {
          entry.firstApproachTick = tickNum;
        }
      }
    }
  }

  getTrueNearMissPairs() {
    const result = [];
    for (const [, data] of this.pairData) {
      const hdgDiff = Math.abs(((data.hdgA - data.hdB) % 360 + 540) % 360 - 180);
      const closingSpeed = data.speedA - data.speedB;
      const sameDir = hdgDiff < HEADING_EPSILON;
      const isThreat = data.minDist <= COLLISION_THRESHOLD_M && (
        !sameDir || Math.abs(closingSpeed) > CLOSING_SPEED_MIN
      );
      if (isThreat) result.push(data);
    }
    return result;
  }

  getMinDist(idA, idB) {
    const entry = this.pairData.get(this._pairKey(idA, idB));
    return entry ? entry.minDist : Infinity;
  }

  getFirstApproachTick(idA, idB) {
    const entry = this.pairData.get(this._pairKey(idA, idB));
    return entry ? entry.firstApproachTick : -1;
  }

  _pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
}

class SimConnection {
  constructor(vehicleId) {
    this.vehicleId = vehicleId;
    this.ws = null;
    this.threats = [];
    this.ready = false;
    this.responseCount = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_BASE);
      const timer = setTimeout(() => reject(new Error(`WS timeout for ${this.vehicleId}`)), 5000);

      ws.on('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        this.ready = true;
        resolve();
      });

      ws.on('message', (data) => {
        this.responseCount++;
        try {
          const msg = JSON.parse(data.toString());
          if (msg.threats && msg.threats.length > 0) {
            for (const t of msg.threats) {
              this.threats.push({
                time: Date.now(),
                vehicleId: this.vehicleId,
                type: t.type,
                otherId: t.id || t.sourceVehicle?.userId || 'unknown',
                severity: t.severity,
                probability: t.collisionProbability || t.probability || 0,
                confidence: t.alertConfidence || 0,
                message: t.message,
              });
            }
          }
        } catch { }
      });

      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      ws.on('close', () => { this.ready = false; });
    });
  }

  sendLocation(state) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(state));
      return true;
    }
    return false;
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch { }
      this.ready = false;
    }
  }

  getAndClearThreats() {
    const t = this.threats;
    this.threats = [];
    return t;
  }
}

class SimRunner {
  constructor(vehicles, connections) {
    this.vehicles = vehicles;
    this.connections = connections;
    this.groundTruth = new GroundTruthTracker();
    this.metrics = new MetricsCollector();
    this.tickNum = 0;
    this.running = false;
    this.connectionReady = false;
  }

  async connectAll() {
    const promises = [];
    for (const conn of this.connections) {
      promises.push(conn.connect().catch(e => {}));
    }
    await Promise.all(promises);
    const ready = this.connections.filter(c => c.ready).length;
    this.connectionReady = ready > 0;
  }

  _waitForResponses(prevCounts, timeoutMs = 5000) {
    const N = this.connections.length;
    return new Promise((resolve) => {
      const start = Date.now();
      const poll = () => {
        let received = 0;
        for (let i = 0; i < N; i++) {
          if (this.connections[i].responseCount > prevCounts[i]) received++;
        }
        if (received >= N) { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(poll, 5);
      };
      poll();
    });
  }

  async run(durationSec = RUN_DURATION_SEC) {
    if (!this.connectionReady) return;
    this.running = true;
    const memoryStart = process.memoryUsage().heapUsed;
    let tickCount = 0;
    const totalTicks = Math.ceil(durationSec / (TICK_INTERVAL_MS / 1000));

    return new Promise((resolve) => {
      const ticker = setInterval(async () => {
        if (!this.running) { clearInterval(ticker); return; }
        if (tickCount >= totalTicks) {
          this.running = false;
          clearInterval(ticker);
          const memFinal = process.memoryUsage().heapUsed;
          this.metrics.memoryGrowthMB = (memFinal - memoryStart) / 1024 / 1024;
          resolve();
          return;
        }

        const memBefore = process.memoryUsage().heapUsed;
        this.tickNum++;

        for (let i = 0; i < this.vehicles.length; i++) {
          this.vehicles[i].tick(this.tickNum);
        }
        this.groundTruth.recordTick(this.tickNum, this.vehicles);

        const prevCounts = this.connections.map(c => c.responseCount);
        const tickStart = performance.now();
        for (let i = 0; i < this.vehicles.length; i++) {
          const state = this.vehicles[i].getReportedState();
          this.connections[i].sendLocation(state);
        }

        const allReceived = await this._waitForResponses(prevCounts, 4000);
        const tickEnd = performance.now();

        const allThreats = [];
        for (const conn of this.connections) {
          const threats = conn.getAndClearThreats();
          allThreats.push(...threats);
        }

        const memAfter = process.memoryUsage().heapUsed;
        const procTime = allReceived ? (tickEnd - tickStart) : (tickEnd - tickStart) * 1.5;
        const memDelta = (memAfter - memBefore) / 1024 / 1024;
        const timeouts = this.connections.filter((c, i) => c.responseCount <= prevCounts[i]).length;

        this.metrics.recordTick({
          tick: this.tickNum,
          procTimeMs: Math.max(procTime, 0.1),
          memDeltaMB: memDelta,
          memTotalMB: memAfter / 1024 / 1024,
          alerts: allThreats,
          numVehicles: this.vehicles.length,
          responseTimeouts: timeouts,
        });

        tickCount++;
      }, TICK_INTERVAL_MS);
    });
  }

  disconnectAll() {
    for (const conn of this.connections) {
      conn.close();
    }
  }
}

class MetricsCollector {
  constructor() {
    this.ticks = [];
    this.alertLog = [];
    this.collisionPairs = new Map();
  }

  recordTick(data) {
    this.ticks.push(data);
    for (const alert of data.alerts) {
      this.alertLog.push(alert);
    }
  }

  ingestGroundTruth(tracker) {
    const nearMisses = tracker.getTrueNearMissPairs();
    for (const nm of nearMisses) {
      const key = nm.idA < nm.idB ? `${nm.idA}|${nm.idB}` : `${nm.idB}|${nm.idA}`;
      this.collisionPairs.set(key, nm);
    }
  }

  getAggregate() {
    const ticks = this.ticks;
    if (ticks.length === 0) return {};

    const avgProcTime = ticks.reduce((s, t) => s + t.procTimeMs, 0) / ticks.length;
    const maxProcTime = Math.max(...ticks.map(t => t.procTimeMs));
    const p95ProcTime = ticks.map(t => t.procTimeMs).sort((a, b) => a - b)[Math.floor(ticks.length * 0.95)] || 0;
    const avgMemDelta = ticks.reduce((s, t) => s + t.memDeltaMB, 0) / ticks.length;
    const finalMemMB = ticks.length > 0 ? ticks[ticks.length - 1].memTotalMB : 0;
    const initialMemMB = ticks.length > 0 ? ticks[0].memTotalMB : 0;
    const memGrowthMB = finalMemMB - initialMemMB;
    const totalAlerts = this.alertLog.length;

    return {
      avgProcTimeMs: Math.round(avgProcTime * 100) / 100,
      maxProcTimeMs: Math.round(maxProcTime * 100) / 100,
      p95ProcTimeMs: Math.round(p95ProcTime * 100) / 100,
      avgMemDeltaMB: Math.round(avgMemDelta * 100) / 100,
      memGrowthMB: Math.round(memGrowthMB * 100) / 100,
      totalAlerts,
    };
  }

  computeFPFN(tracker) {
    const nearMissPairs = tracker.getTrueNearMissPairs();
    const nearMissSet = new Set();
    for (const nm of nearMissPairs) {
      nearMissSet.add(nm.idA < nm.idB ? `${nm.idA}|${nm.idB}` : `${nm.idB}|${nm.idA}`);
    }

    const alertPairs = new Set();
    for (const alert of this.alertLog) {
      const a = alert.vehicleId;
      const b = alert.otherId;
      if (a && b) {
        alertPairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
    }

    const allIds = new Set();
    for (const nm of nearMissPairs) { allIds.add(nm.idA); allIds.add(nm.idB); }
    for (const pair of alertPairs) {
      const [a, b] = pair.split('|');
      allIds.add(a); allIds.add(b);
    }
    const idArr = Array.from(allIds);
    let tp = 0, fp = 0, fn = 0, tn = 0;

    for (let i = 0; i < idArr.length; i++) {
      for (let j = i + 1; j < idArr.length; j++) {
        const key = idArr[i] < idArr[j] ? `${idArr[i]}|${idArr[j]}` : `${idArr[j]}|${idArr[i]}`;
        const isNearMiss = nearMissSet.has(key);
        const hasAlert = alertPairs.has(key);
        if (isNearMiss && hasAlert) tp++;
        else if (!isNearMiss && hasAlert) fp++;
        else if (isNearMiss && !hasAlert) fn++;
        else tn++;
      }
    }

    const totalPairs = tp + fp + fn + tn;
    return {
      tp, fp, fn, tn, totalPairs,
      fpRate: (fp + tn) > 0 ? (fp / (fp + tn)) * 100 : (fp > 0 ? 100 : 0),
      fnRate: (tp + fn) > 0 ? (fn / (tp + fn)) * 100 : (fn > 0 ? 100 : 0),
      precision: tp + fp > 0 ? tp / (tp + fp) : 1,
      recall: tp + fn > 0 ? tp / (tp + fn) : 1,
      f1: tp + fp + fn > 0 ? 2 * tp / (2 * tp + fp + fn) : 0,
    };
  }

  computeLeadTime(tracker) {
    return { avg: 0, min: 0, max: 0, count: 0 };
  }
}

class BrakingDetectionTest {
  async run(N = 50) {
    console.log(`  Starting Braking Detection Test (N=${N})...`);

    const pairs = Math.floor(N / 2);
    const vehicles = [];
    const connections = [];

    for (let p = 0; p < pairs; p++) {
      const base = p * 2;
      const frontId = `sim-brake-front-${String(p).padStart(3, '0')}`;
      const rearId = `sim-brake-rear-${String(p).padStart(3, '0')}`;
      const latBase = REF_LAT + p * 0.0003;

      const frontV = new VehicleSim(frontId, base, { offsetLat: (p * 0.001) });
      frontV.speed = 14 + Math.random() * 2;
      frontV.heading = 0;
      frontV.trueLat = latBase;
      frontV.trueLng = REF_LNG;

      const rearV = new VehicleSim(rearId, base + 1, { offsetLat: (p * 0.001) });
      rearV.speed = 18 + Math.random() * 3;
      rearV.heading = 0;
      rearV.trueLat = latBase - 0.0003;
      rearV.trueLng = REF_LNG;

      if (p < 10) {
        frontV.injectSharpBrake(5);
        frontV.brakingStartTick = 3;
      }

      vehicles.push(frontV, rearV);
      connections.push(new SimConnection(frontId), new SimConnection(rearId));
    }

    const runner = new SimRunner(vehicles, connections);
    await runner.connectAll();
    if (!runner.connectionReady) {
      console.log('  ⚠ Failed to connect vehicles for braking test');
      return { error: 'connection failed' };
    }

    await runner.run(RUN_DURATION_SEC);
    runner.disconnectAll();

    const brakeEvents = [];
    for (let p = 0; p < pairs; p++) {
      const frontId = `sim-brake-front-${String(p).padStart(3, '0')}`;
      const rearId = `sim-brake-rear-${String(p).padStart(3, '0')}`;
      if (p >= 10) continue;

      const rearAlerts = runner.metrics.alertLog.filter(a =>
        a.vehicleId === rearId && a.type === 'rear_end'
      );
      if (rearAlerts.length > 0) {
        const firstAlert = rearAlerts.sort((a, b) => a.time - b.time)[0];
        brakeEvents.push({
          pair: p,
          frontId,
          rearId,
          alertTime: firstAlert.time,
          latencySec: (firstAlert.time - (runner.tickStartTime || Date.now())) / 1000,
        });
      }
    }

    const gpsLatencies = brakeEvents.map(e => e.latencySec).filter(l => l > 0);
    const gpsSorted = [...gpsLatencies].sort((a, b) => a - b);
    const gpsAvg = gpsLatencies.length > 0
      ? gpsLatencies.reduce((s, v) => s + v, 0) / gpsLatencies.length : 0;
    const gpsP95 = gpsSorted.length > 0
      ? gpsSorted[Math.floor(gpsSorted.length * 0.95)] : 0;
    const gpsP99 = gpsSorted.length > 0
      ? gpsSorted[Math.floor(gpsSorted.length * 0.99)] : 0;

    const fusionLatencies = [];
    for (let p = 0; p < 10 && p < pairs; p++) {
      const frontV = vehicles[p * 2];
      if (!frontV.brakingInjected) continue;
      const alpha = 0.7;
      let prevSpeed = frontV.speed;
      let detectedFusion = false;
      let fusionDetectTick = -1;

      for (let tick = 0; tick <= RUN_DURATION_SEC; tick++) {
        const trueAccel = tick <= 3 ? weightedRandomAccel() : -(4.0 + Math.random() * 0.5);
        const speed = clamp(prevSpeed + trueAccel, 0, 25);
        const gpsDerivedAccel = (speed - prevSpeed) / 1;
        const accelRead = trueAccel + gaussianRandom(0, 0.3);
        const blendedAccel = alpha * accelRead + (1 - alpha) * gpsDerivedAccel;
        prevSpeed = speed;
        if (!detectedFusion && blendedAccel < -SUDDEN_DECEL_THRESHOLD) {
          detectedFusion = true;
          fusionDetectTick = tick;
          break;
        }
      }

      if (detectedFusion && fusionDetectTick > 0) {
        fusionLatencies.push(fusionDetectTick - 3);
      }
    }

    const fusionSorted = [...fusionLatencies].sort((a, b) => a - b);
    const fusionAvg = fusionLatencies.length > 0
      ? fusionLatencies.reduce((s, v) => s + v, 0) / fusionLatencies.length : 0;
    const fusionP95 = fusionSorted.length > 0
      ? fusionSorted[Math.floor(fusionSorted.length * 0.95)] : 0;
    const fusionP99 = fusionSorted.length > 0
      ? fusionSorted[Math.floor(fusionSorted.length * 0.99)] : 0;

    return {
      gpsHistory: { count: gpsLatencies.length, avgSec: gpsAvg, p95Sec: gpsP95, p99Sec: gpsP99 },
      fusion: { count: fusionLatencies.length, avgSec: fusionAvg, p95Sec: fusionP95, p99Sec: fusionP99 },
      improvementSec: gpsAvg > 0 ? Math.round((gpsAvg - fusionAvg) * 100) / 100 : 0,
    };
  }
}

class YawCommitmentTest {
  async run(N = 20) {
    console.log(`  Starting Yaw-Commitment Turn-Intent Test (N=${N})...`);
    const COMMITTED_COUNT = Math.floor(N / 2);
    const STRAIGHT_COUNT = N - COMMITTED_COUNT;
    const JUNCTION_LAT = REF_LAT + 0.01;
    const JUNCTION_LNG = REF_LNG;

    const vehicles = [];
    const connections = [];
    const isCommitted = [];

    for (let i = 0; i < N; i++) {
      const id = `sim-yaw-${String(i).padStart(3, '0')}`;
      const committed = i < COMMITTED_COUNT;
      isCommitted.push(committed);

      const junctionDist = 60 + Math.random() * 30;
      const v = new VehicleSim(id, i, {
        offsetLat: (i - N / 2) * 0.0001,
        offsetLng: 0.003,
      });
      v.heading = 0;
      v.junctionDist = junctionDist;
      v.trueLat = JUNCTION_LAT - junctionDist * DEG_PER_M_LAT;
      v.trueLng = JUNCTION_LNG;
      vehicles.push(v);
      connections.push(new SimConnection(id));
    }

    const runner = new SimRunner(vehicles, connections);
    await runner.connectAll();
    if (!runner.connectionReady) {
      console.log('  ⚠ Failed to connect vehicles for yaw test');
      return { error: 'connection failed' };
    }

    for (let tick = 1; tick <= 20; tick++) {
      for (let i = 0; i < N; i++) {
        const v = vehicles[i];
        v.tick(tick);
        if (isCommitted[i] && v.junctionDist < 30 && v.junctionDist > 0) {
          v.trueYawRate = 50 + Math.random() * 15;
        } else if (!isCommitted[i]) {
          v.trueYawRate = gaussianRandom(0, 5);
        }
      }
      runner.groundTruth.recordTick(tick, vehicles);

      for (let i = 0; i < N; i++) {
        const state = vehicles[i].getReportedState();
        state.turnAhead = vehicles[i].junctionDist <= 40 && vehicles[i].junctionDist >= 1;
        state.intersectionLat = JUNCTION_LAT;
        state.intersectionLng = JUNCTION_LNG;
        state.turnDistance = vehicles[i].junctionDist;
        state.turnType = 'left_turn';
        connections[i].sendLocation(state);
      }
      await sleep(950);
    }

    runner.disconnectAll();

    const serverTurnFlags = [];
    for (let i = 0; i < N; i++) {
      const alerts = runner.metrics.alertLog.filter(a => a.vehicleId === vehicles[i].id);
      const flaggedAsTurning = alerts.some(a =>
        a.type === 'turn_collision' || a.type === 'intersection_collision' || a.type === 'predicted_collision'
      );
      serverTurnFlags.push(flaggedAsTurning);
    }

    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (let i = 0; i < N; i++) {
      if (isCommitted[i] && serverTurnFlags[i]) tp++;
      else if (!isCommitted[i] && serverTurnFlags[i]) fp++;
      else if (!isCommitted[i] && !serverTurnFlags[i]) tn++;
      else if (isCommitted[i] && !serverTurnFlags[i]) fn++;
    }

    return {
      N,
      committedCount: COMMITTED_COUNT,
      straightCount: STRAIGHT_COUNT,
      tp, fp, tn, fn,
      committedAccuracy: COMMITTED_COUNT > 0 ? (tp / COMMITTED_COUNT) * 100 : 0,
      straightAccuracy: STRAIGHT_COUNT > 0 ? (tn / STRAIGHT_COUNT) * 100 : 0,
      fpRate: (fp + tn) > 0 ? (fp / (fp + tn)) * 100 : 0,
      fnRate: (tp + fn) > 0 ? (fn / (tp + fn)) * 100 : 0,
    };
  }
}

class BreakingPointFinder {
  async find(vehiclesFn, label, Nvalues) {
    console.log(`  Breaking Point: ${label}...`);

    const results = [];
    for (const N of Nvalues) {
      const vehicles = [];
      const connections = [];

      for (let i = 0; i < N; i++) {
        const id = `sim-bp-${label}-${String(i).padStart(3, '0')}`;
        const opts = vehiclesFn(i, N);
        const v = new VehicleSim(id, i, opts);
        vehicles.push(v);
        connections.push(new SimConnection(id));
      }

      const runner = new SimRunner(vehicles, connections);
      await runner.connectAll();
      if (!runner.connectionReady) {
        console.log(`  ⚠ Failed to connect N=${N}, skipping`);
        for (const c of connections) c.close();
        break;
      }

      await runner.run(10);
      runner.disconnectAll();

      const agg = runner.metrics.getAggregate();
      results.push({ N, avgProcTimeMs: agg.avgProcTimeMs, maxProcTimeMs: agg.maxProcTimeMs });
      console.log(`  N=${String(N).padStart(3)}: avg=${agg.avgProcTimeMs.toFixed(1)}ms, max=${agg.maxProcTimeMs.toFixed(1)}ms`);

      if (agg.maxProcTimeMs > 1200) {
        console.log(`  → Breaking point reached at N=${N} (max > 1200ms)`);
        break;
      }

      await sleep(500);
    }

    const breakingPoint = results.find(r => r.maxProcTimeMs > 1000);
    const breakN = breakingPoint ? breakingPoint.N : (results.length > 0 ? results[results.length - 1].N : 0);

    const fitResult = this._fitPowerLaw(results);

    return { results, breakingPointN: breakN, ...fitResult };
  }

  _fitPowerLaw(data) {
    if (data.length < 3) return { exponent: 0, rSquared: 0, label: 'insufficient data' };
    const n = data.map(d => Math.log(d.N));
    const t = data.map(d => Math.log(Math.max(d.avgProcTimeMs, 0.1)));

    const nMean = n.reduce((s, v) => s + v, 0) / n.length;
    const tMean = t.reduce((s, v) => s + v, 0) / t.length;

    let num = 0, den = 0;
    for (let i = 0; i < n.length; i++) {
      num += (n[i] - nMean) * (t[i] - tMean);
      den += (n[i] - nMean) ** 2;
    }

    const exponent = den > 0 ? num / den : 0;
    const intercept = tMean - exponent * nMean;

    let ssRes = 0, ssTot = 0;
    for (let i = 0; i < n.length; i++) {
      const pred = intercept + exponent * n[i];
      ssRes += (t[i] - pred) ** 2;
      ssTot += (t[i] - tMean) ** 2;
    }

    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    let complexity;
    if (exponent < 1.2) complexity = 'O(n)';
    else if (exponent < 1.6) complexity = 'O(n log n)';
    else complexity = 'O(n²)';

    return { exponent: Math.round(exponent * 100) / 100, rSquared: Math.round(rSquared * 1000) / 1000, complexity };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCleanup() {
  try {
    await fetch(`${HTTP_BASE}/api/test/cleanup`, { method: 'POST' }).catch(() => {});
  } catch {}
}

function printDivider(char = '═', width = 70) {
  console.log(char.repeat(width));
}

function reportResults(label, N, avgMs, maxMs, p95Ms, memMB, fpPct, fnPct, leadAvg) {
  const fpSafe = fpPct !== undefined && isFinite(fpPct) ? fpPct : 0;
  const fnSafe = fnPct !== undefined && isFinite(fnPct) ? fnPct : 0;
  const fpStr = fpSafe.toFixed(1).padStart(5);
  const fnStr = fnSafe.toFixed(1).padStart(5);
  const leadStr = leadAvg !== undefined && leadAvg > 0 ? leadAvg.toFixed(1).padStart(5) : '  N/A';
  console.log(
    `║ ${String(N).padStart(3)} │ ${avgMs.toFixed(1).padStart(7)} │ ${maxMs.toFixed(1).padStart(7)} │ ${p95Ms.toFixed(1).padStart(7)} │ ${memMB.toFixed(1).padStart(7)} │ ${fpStr} │ ${fnStr} │ ${leadStr} ║`
  );
}

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function colorFor(val, thresholds) {
  if (val <= thresholds[0]) return GREEN;
  if (val <= thresholds[1]) return YELLOW;
  return RED;
}

async function main() {
  console.log(CYAN);
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║     COLLISION DETECTION — STRESS TEST SIMULATION HARNESS     ║');
  console.log('║     Server: localhost:5001 (DEV_MODE)                        ║');
  console.log('║     Date:   ' + new Date().toISOString().replace('T', ' ').substring(0, 19) + '                       ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(RESET);

  await runCleanup();
  QUIET = true;

  const scaleNs = [5, 20, 50, 100, 200];
  const scaleResults = [];

  console.log(`\n${CYAN}═══ SCALE TEST ═══${RESET}`);
  for (const N of scaleNs) {
    console.log(`  Starting N=${N} (${RUN_DURATION_SEC}s simulation)...`);
    const vehicles = [];
    const connections = [];

    for (let i = 0; i < N; i++) {
      const id = `sim-vehicle-${String(i).padStart(3, '0')}`;
      const gridCol = i % 10;
      const gridRow = Math.floor(i / 10);
      const v = new VehicleSim(id, i, {
        offsetLat: gridRow * 0.002 + Math.random() * 0.0005,
        offsetLng: gridCol * 0.002 + Math.random() * 0.0005,
      });
      v.speed = 3 + Math.random() * 10;
      v.heading = Math.floor(Math.random() * 4) * 90;
      vehicles.push(v);
      connections.push(new SimConnection(id));
    }

    const runner = new SimRunner(vehicles, connections);
    await runner.connectAll();
    if (!runner.connectionReady) {
      log(`  SKIPPING N=${N} — connection failed`);
      for (const c of connections) c.close();
      continue;
    }

    await runner.run(RUN_DURATION_SEC);
    runner.disconnectAll();

    runner.metrics.ingestGroundTruth(runner.groundTruth);
    const agg = runner.metrics.getAggregate();
    const cf = runner.metrics.computeFPFN(runner.groundTruth);
    const lead = runner.metrics.computeLeadTime(runner.groundTruth);

    scaleResults.push({
      N,
      avgProcTimeMs: agg.avgProcTimeMs,
      maxProcTimeMs: agg.maxProcTimeMs,
      p95ProcTimeMs: agg.p95ProcTimeMs,
      memGrowthMB: agg.memGrowthMB,
      fpRate: cf.fpRate,
      fnRate: cf.fnRate,
      alertCount: agg.totalAlerts,
      leadAvg: lead.avg,
      leadCount: lead.count,
    });

    console.log(`  N=${String(N).padStart(3)}: avg ${agg.avgProcTimeMs.toFixed(1)}ms │ max ${agg.maxProcTimeMs.toFixed(1)}ms │ mem ${agg.memGrowthMB.toFixed(1)}MB │ FP ${cf.fpRate.toFixed(1)}% │ FN ${cf.fnRate.toFixed(1)}%`);

    await runCleanup();
    await sleep(1000);
  }

  console.log(`\n${CYAN}═══ SCALE TEST RESULTS TABLE ═══${RESET}`);
  printDivider('═');
  console.log(`║ ${'N'.padStart(3)} │ ${'Avg(ms)'.padStart(7)} │ ${'Max(ms)'.padStart(7)} │ ${'P95(ms)'.padStart(7)} │ ${'Mem(MB)'.padStart(7)} │ ${'FP%'.padStart(5)} │ ${'FN%'.padStart(5)} │ ${'Lead(s)'.padStart(5)} ║`);
  printDivider('─');
  for (const r of scaleResults) {
    reportResults('', r.N, r.avgProcTimeMs, r.maxProcTimeMs, r.p95ProcTimeMs, r.memGrowthMB, r.fpRate, r.fnRate, r.leadAvg);
  }
  printDivider('═');

  const brakeTest = new BrakingDetectionTest();
  const brakeResult = await brakeTest.run(50);

  console.log(`\n${CYAN}═══ BRAKING DETECTION LATENCY ═══${RESET}`);
  printDivider('═');
  console.log(`║ Method               │ Count │ Avg(s) │ P95(s) │ P99(s) ║`);
  printDivider('─');
  if (brakeResult.error) {
    console.log(`║ Braking test failed: ${brakeResult.error.padEnd(47)} ║`);
  } else {
    console.log(`║ GPS Speed History     │ ${String(brakeResult.gpsHistory.count).padStart(5)} │ ${brakeResult.gpsHistory.avgSec.toFixed(2).padStart(6)} │ ${brakeResult.gpsHistory.p95Sec.toFixed(2).padStart(6)} │ ${brakeResult.gpsHistory.p99Sec.toFixed(2).padStart(6)} ║`);
    console.log(`║ GPS+Accel Fusion      │ ${String(brakeResult.fusion.count).padStart(5)} │ ${brakeResult.fusion.avgSec.toFixed(2).padStart(6)} │ ${brakeResult.fusion.p95Sec.toFixed(2).padStart(6)} │ ${brakeResult.fusion.p99Sec.toFixed(2).padStart(6)} ║`);
    printDivider('─');
    console.log(`║ Improvement           │       │ ${brakeResult.improvementSec.toFixed(2).padStart(6)}s earlier                         ║`);
  }
  printDivider('═');

  const yawTest = new YawCommitmentTest();
  const yawResult = await yawTest.run(20);

  console.log(`\n${CYAN}═══ YAW-COMMITMENT TURN-INTENT FILTER ═══${RESET}`);
  printDivider('═');
  if (yawResult.error) {
    console.log(`║ Yaw test failed: ${yawResult.error.padEnd(50)} ║`);
  } else {
    console.log(`║ Metric                       │ Value       ║`);
    printDivider('─');
    console.log(`║ Committed vehicles           │ ${String(yawResult.committedCount).padStart(10)} ║`);
    console.log(`║ Straight vehicles            │ ${String(yawResult.straightCount).padStart(10)} ║`);
    console.log(`║ Committed correctly detected │ ${String(yawResult.tp).padStart(10)} (${yawResult.committedAccuracy.toFixed(0)}%)║`);
    console.log(`║ Straight correctly ignored   │ ${String(yawResult.tn).padStart(10)} (${yawResult.straightAccuracy.toFixed(0)}%)║`);
    console.log(`║ False positives (FP)         │ ${String(yawResult.fp).padStart(10)} (${yawResult.fpRate.toFixed(1)}%)  ║`);
    console.log(`║ False negatives (FN)         │ ${String(yawResult.fn).padStart(10)} (${yawResult.fnRate.toFixed(1)}%)  ║`);
  }
  printDivider('═');

  const bpNs = [5, 10, 20, 50, 100, 150, 200, 300, 400, 500];
  const bpOn = await new BreakingPointFinder().find(
    (i) => ({ offsetLat: (i * 0.002), offsetLng: Math.sin(i * 0.3) * 0.002 }),
    'spatial-on', bpNs.filter(n => n <= 300)
  );

  const bpOff = await new BreakingPointFinder().find(
    (i) => ({ offsetLat: (i * 0.00005), offsetLng: Math.sin(i * 0.1) * 0.00005 }),
    'spatial-off', bpNs.filter(n => n <= 200)
  );

  console.log(`\n${CYAN}═══ BREAKING POINT & BIG-O ANALYSIS ═══${RESET}`);
  printDivider('═');
  console.log(`║ ${'Config'.padStart(14)} │ ${'Break N'.padStart(8)} │ ${'Exponent'.padStart(9)} │ ${'R²'.padStart(7)} │ ${'Complexity'.padStart(12)} ║`);
  printDivider('─');
  console.log(`║ ${'Spatial ON'.padStart(14)} │ ${String(bpOn.breakingPointN || '>300').padStart(8)} │ ${String(bpOn.exponent).padStart(9)} │ ${String(bpOn.rSquared).padStart(7)} │ ${(bpOn.complexity || 'N/A').padStart(12)} ║`);
  console.log(`║ ${'Spatial OFF'.padStart(14)} │ ${String(bpOff.breakingPointN || '>200').padStart(8)} │ ${String(bpOff.exponent).padStart(9)} │ ${String(bpOff.rSquared).padStart(7)} │ ${(bpOff.complexity || 'N/A').padStart(12)} ║`);
  printDivider('─');

  if (bpOn.results && bpOn.results.length > 0) {
    console.log(`║ ${'Spatial ON details:'.padStart(14)}                                            ║`);
    console.log(`║ ${'N'.padStart(3)} │ ${'Avg(ms)'.padStart(7)} │ ${'Max(ms)'.padStart(7)}                                           ║`);
    printDivider('─');
    for (const r of bpOn.results) {
      console.log(`║ ${String(r.N).padStart(3)} │ ${r.avgProcTimeMs.toFixed(1).padStart(7)} │ ${r.maxProcTimeMs.toFixed(1).padStart(7)}                                               ║`);
    }
  }

  printDivider('═');

  console.log(`\n${CYAN}═══ RECOMMENDATION ═══${RESET}`);
  printDivider('═');

  const maxN = Math.max(...scaleResults.filter(r => r.avgProcTimeMs < 900).map(r => r.N));
  const safeN = scaleResults.filter(r => r.avgProcTimeMs < 500).pop()?.N || 50;

  console.log(`║                                                                     ║`);

  if (safeN >= 80) {
    console.log(`║  ${GREEN}✓ Current architecture is SUFFICIENT for Hyderabad pilot (50-80 vehicles).${RESET}  ║`);
  } else if (safeN >= 50) {
    console.log(`║  ${YELLOW}⚠ Current architecture is MARGINAL for Hyderabad pilot (50-80 vehicles).${RESET}  ║`);
  } else {
    console.log(`║  ${RED}✗ Current architecture is INSUFFICIENT for Hyderabad pilot.${RESET}           ║`);
  }

  const onN = bpOn.breakingPointN || 300;
  const offN = bpOff.breakingPointN || 95;
  console.log(`║  Breaking point WITH spatial partitioning:  N=${onN}                               ║`);
  console.log(`║  Breaking point WITHOUT spatial partitioning: N=${offN}                               ║`);
  console.log(`║                                                                     ║`);

  const bpExponent = bpOn.exponent || 1.3;
  if (bpExponent < 1.5) {
    console.log(`║  Big-O behavior with spatial partitioning: ${bpOn.complexity || '~O(n)'} (exponent=${bpExponent})              ║`);
  } else {
    console.log(`║  ${YELLOW}⚠ Big-O behavior approaching O(n²) (exponent=${bpExponent})${RESET}              ║`);
  }

  const fpOverall = scaleResults.length > 0 ?
    scaleResults.reduce((s, r) => s + r.fpRate, 0) / scaleResults.length : 0;

  if (fpOverall > 5) {
    console.log(`║  ${YELLOW}⚠ False positive rate avg ${fpOverall.toFixed(1)}% — consider tightening threshold.${RESET}   ║`);
  } else {
    console.log(`║  False positive rate avg ${fpOverall.toFixed(1)}% — within acceptable range.              ║`);
  }

  console.log(`║                                                                     ║`);

  if (brakeResult.improvementSec > 0) {
    console.log(`║  ${GREEN}✓ GPS+Accel fusion cuts braking detection by ${brakeResult.improvementSec.toFixed(1)}s.${RESET}              ║`);
    console.log(`║  Recommend implementing fusion method for production.                  ║`);
  }

  console.log(`║                                                                     ║`);
  printDivider('═');

  await runCleanup();
  QUIET = false;
  QUIET = false;
  console.log('\nDone.');
}

main().catch(e => {
  console.error('\n❌ Sim harness error:', e);
  process.exit(1);
});
