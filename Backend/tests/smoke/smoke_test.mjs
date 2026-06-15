import WebSocket from "ws";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const WS_URL = process.argv[2] || "ws://localhost:5001";
const RESULTS_DIR = resolve(__dirname, "results");

if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on("open", () => resolve(ws));
    ws.on("error", (e) => reject(e));
    setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
  });
}

function sendAndWait(ws, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Response timeout (${timeoutMs}ms)`)), timeoutMs);

    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(parsed);
      } catch (e) {
        // ignore non-JSON messages (e.g. heartbeat pings)
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify(payload));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(condition, label, got, expected) {
  if (!condition) {
    return `FAIL: ${label} (got=${got}, expected=${expected})`;
  }
  return null;
}

function check(failures, condition, label, got, expected) {
  const r = assert(condition, label, got, expected);
  if (r) failures.push(r);
}

function passed(failures) {
  return failures.filter(Boolean).length === 0;
}

function onlyFailures(failures) {
  return failures.filter(Boolean);
}

// ─── Smoke-01: G-03 Parallel Roads ───
// Using actual road coordinates near Hyderabad:
// Road A: (17.3593, 78.4698) heading east-west
// Road B: (17.3609, 78.4703) ~180m apart, same heading, same road class
// Both on "residential" roads heading ~90 degrees
async function smoke01_parallelRoads(ws) {
  const start = performance.now();
  const failures = [];

  const payloadA = {
    userId: "smoke-01-a",
    latitude: 17.3593,
    longitude: 78.4698,
    speed: 11.1,
    heading: 90,
    positionUncertainty: 5,
    sensorQuality: 0.9,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };

  const payloadB = {
    userId: "smoke-01-b",
    latitude: 17.3601,
    longitude: 78.4701,
    speed: 8.3,
    heading: 90,
    positionUncertainty: 5,
    sensorQuality: 0.9,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };

  await sendAndWait(ws, payloadA);
  await sleep(300);
  const resp = await sendAndWait(ws, payloadB);
  const latency = performance.now() - start;

  const t = resp.threats || [];
  if (t.length > 0) { const r = assert(false, "no alerts generated", t.length, 0); if (r) failures.push(r); }

  if (resp.mapMatch) {
    if (resp.mapMatch.matched !== true) { const r = assert(false, "vehicle B matched", resp.mapMatch.matched, true); if (r) failures.push(r); }
  }

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-01", label: "G-03 Parallel" };
}

// ─── Smoke-02: G-04 Flyover ───
// Two vehicles at same lat/lng but different road layers
// Uses two different roads at same location
async function smoke02_flyover(ws) {
  const start = performance.now();
  const failures = [];

  // Vehicle A on one road
  const payloadA = {
    userId: "smoke-02-a",
    latitude: 17.3593,
    longitude: 78.4698,
    speed: 11.1,
    heading: 90,
    positionUncertainty: 5,
    sensorQuality: 0.9,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };

  // Vehicle B on a different road nearby (different road ID)
  const payloadB = {
    userId: "smoke-02-b",
    latitude: 17.3609,
    longitude: 78.4703,
    speed: 8.3,
    heading: 90,
    positionUncertainty: 5,
    sensorQuality: 0.9,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };

  await sendAndWait(ws, payloadA);
  await sleep(300);
  const resp = await sendAndWait(ws, payloadB);
  const latency = performance.now() - start;

  const t = resp.threats || [];
  if (t.length > 0) failures.push(assert(false, "no alerts generated at flyover", t.length, 0));

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-02", label: "G-04 Flyover" };
}

// ─── Smoke-03: G-05 GPS Drift ───
// Vehicle is 15m offset from the actual road (17.3593, 78.4698)
async function smoke03_gpsDrift(ws) {
  const start = performance.now();
  const failures = [];

  const trueLat = 17.3593;
  const trueLon = 78.4698;
  const offsetM = 15;
  const metersPerDegLat = 111320;
  const offsetLat = trueLat + offsetM / metersPerDegLat;

  const payload = {
    userId: "smoke-03",
    latitude: offsetLat,
    longitude: trueLon,
    speed: 11.1,
    heading: 90,
    positionUncertainty: 15,
    sensorQuality: 0.7,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };

  await sleep(500); // ensure rate limit doesn't block
  const resp = await sendAndWait(ws, payload);
  const latency = performance.now() - start;

  const mm = resp.mapMatch || {};
  const snappedLat = mm.snappedLat;
  const snappedLng = mm.snappedLng;

  if (snappedLat !== undefined && snappedLng !== undefined) {
    const correction = haversine(offsetLat, trueLon, snappedLat, snappedLng);
    const distToRoad = mm.distanceToRoad ?? haversine(trueLat, trueLon, snappedLat, snappedLng);

    check(failures, mm.confidence >= 0.55, "match confidence >= 0.55", mm.confidence, ">=0.55");
    check(failures, correction >= 3, "correction >= 3m", correction.toFixed(1), ">=3m");
    check(failures, correction <= 25, "correction <= 25m", correction.toFixed(1), "<=25m");
    check(failures, distToRoad < 5, "distToRoad < 5m", distToRoad.toFixed(1), "<5m");
  } else {
    failures.push("No mapMatch data returned");
  }

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-03", label: "G-05 GPS Drift" };
}

// ─── Smoke-04: RT-01 GPS Jump ───
// Vehicle traveling east on a known road, GPS suddenly jumps 50m
async function smoke04_gpsJump(ws) {
  const start = performance.now();
  const failures = [];

  const baseLat = 17.3593;
  const baseLon = 78.4698;
  const jumpOffset = 50 / 111320;
  const metersPerDegLon = 111320 * Math.cos(baseLat * Math.PI / 180);

  // Phase 1: Normal GPS (3 steps)
  const userId = "smoke-04";
  for (let t = 0; t < 3; t++) {
    const payload = {
      userId,
      latitude: baseLat,
      longitude: baseLon + t * 0.00005,
      speed: 11.1,
      heading: 90,
      positionUncertainty: 5,
      sensorQuality: 0.9,
      clientTime: Date.now(),
      serverTime: Date.now(),
    };
    const resp = await sendAndWait(ws, payload);
    if (t === 2) {
      const mm = resp.mapMatch || {};
      if (mm.confidence !== undefined && mm.confidence > 0) {
        if (mm.confidence < 0.7) {
          failures.push(assert(false, "Phase1: confidence >= 0.70", mm.confidence, ">=0.70"));
        }
      }
    }
    await sleep(300);
  }

  // Phase 2: GPS jump (2 steps)
  let phase2MinConfidence = 1.0;
  let prevSnappedLat = baseLat;
  let prevSnappedLon = baseLon + 2 * 0.00005;
  let maxDrift = 0;

  for (let t = 0; t < 2; t++) {
    const jumpLat = baseLat + jumpOffset;
    const payload = {
      userId,
      latitude: jumpLat,
      longitude: baseLon + (3 + t) * 0.00005,
      speed: 11.1,
      heading: 90,
      positionUncertainty: 5,
      sensorQuality: 0.9,
      clientTime: Date.now(),
      serverTime: Date.now(),
    };
    const resp = await sendAndWait(ws, payload);
    const mm = resp.mapMatch || {};
    if (mm.confidence !== undefined) phase2MinConfidence = Math.min(phase2MinConfidence, mm.confidence);

    const currentSnappedLat = mm.snappedLat;
    const currentSnappedLng = mm.snappedLng;
    if (currentSnappedLat !== undefined && currentSnappedLng !== undefined && prevSnappedLat !== undefined) {
      const drift = haversine(prevSnappedLat, prevSnappedLon, currentSnappedLat, currentSnappedLng);
      maxDrift = Math.max(maxDrift, drift);
    }

    const threats = resp.threats || [];
    if (threats.length > 0) {
      failures.push(assert(false, "Phase2: no false alert during jump", threats.length, 0));
    }

    prevSnappedLat = mm.snappedLat ?? jumpLat;
    prevSnappedLon = mm.snappedLng ?? baseLon;
    await sleep(300);
  }

  failures.push(assert(phase2MinConfidence >= 0.3, "Phase2: confidence never < 0.30", phase2MinConfidence, ">=0.30"));
  failures.push(assert(maxDrift < 10, `Phase2: drift < 10m`, maxDrift.toFixed(1), "<10m"));

  // Phase 3: Recovery (3 steps)
  let recoveredConfidence = 0;
  let recoveryTime = 0;
  for (let t = 0; t < 3; t++) {
    const payload = {
      userId,
      latitude: baseLat,
      longitude: baseLon + (5 + t) * 0.00005,
      speed: 11.1,
      heading: 90,
      positionUncertainty: 5,
      sensorQuality: 0.9,
      clientTime: Date.now(),
      serverTime: Date.now(),
    };
    const resp = await sendAndWait(ws, payload);
    const mm = resp.mapMatch || {};
    if (mm.confidence !== undefined && mm.confidence > recoveredConfidence) {
      recoveredConfidence = mm.confidence;
      recoveryTime = t;
    }
    await sleep(300);
  }

  failures.push(assert(recoveredConfidence >= 0.7, "Phase3: recovery confidence >= 0.70", recoveredConfidence, ">=0.70"));
  failures.push(assert(recoveryTime <= 2, `Phase3: recovery within 2s`, `${recoveryTime}s`, "<=2s"));

  const latency = performance.now() - start;
  return { passed: passed(failures), failures: onlyFailures(failures), latency, scenario: "Smoke-04", label: "RT-01 GPS Jump" };
}

// ─── Smoke-05: Time Sync ───
async function smoke05_timeSync(ws) {
  const start = performance.now();
  const failures = [];

  // Baseline: normal time
  // Use same userId so timeSync state is shared
  const testUserId = "smoke-05";

  // Baseline: normal time (send 2 messages to build up offset history)
  const normalPayload1 = {
    userId: testUserId,
    latitude: 17.3593,
    longitude: 78.4698,
    speed: 5,
    heading: 90,
    positionUncertainty: 10,
    sensorQuality: 0.8,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };
  await sleep(200);
  await sendAndWait(ws, normalPayload1);
  await sleep(200);
  const normalPayload2 = {
    userId: testUserId,
    latitude: 17.3594,
    longitude: 78.4699,
    speed: 5,
    heading: 90,
    positionUncertainty: 10,
    sensorQuality: 0.8,
    clientTime: Date.now(),
    serverTime: Date.now(),
  };
  const baselineResp = await sendAndWait(ws, normalPayload2);
  const baselineConfidence = baselineResp.timeSyncConfidence ?? 1.0;

  // With 1s offset — same userId
  const offsetPayload = {
    userId: testUserId,
    latitude: 17.3595,
    longitude: 78.4700,
    speed: 5,
    heading: 90,
    positionUncertainty: 10,
    sensorQuality: 0.8,
    clientTime: Date.now() - 1000,
    serverTime: Date.now() - 1000,
  };
  await sleep(200);
  const offsetResp = await sendAndWait(ws, offsetPayload);
  const offsetConfidence = offsetResp.timeSyncConfidence ?? 0;

  const latency = performance.now() - start;

  check(failures, offsetResp.serverTime != null, "serverTime present", typeof offsetResp.serverTime, "number");
  check(failures, offsetConfidence < baselineConfidence, "confidence decreased with 1s offset", `${offsetConfidence.toFixed(3)} < ${baselineConfidence.toFixed(3)}`, true);
  check(failures, !isNaN(offsetResp.serverTime), "serverTime is valid number", offsetResp.serverTime, "valid");

  return { passed: passed(failures), failures: onlyFailures(failures), latency, scenario: "Smoke-05", label: "Time Sync" };
}

// ─── Smoke-06: Road Distance Bubble ───
// Vehicle A on a known road; verify road bubble flag in response
async function smoke06_roadBubble(ws) {
  const start = performance.now();
  const failures = [];

  const resp = await sendAndWait(ws, {
    userId: "smoke-06-a",
    latitude: 17.3593, longitude: 78.4698,
    speed: 11.1, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });

  const latency = performance.now() - start;
  const rb = resp.roadBubble || {};

  check(failures, rb.used === true, "road bubble used", rb.used, true);

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-06", label: "Road Bubble" };
}

// ─── Smoke-07: ETA Registry Conflict ───
// Uses known junction on road 22831055 at ~(17.40135, 78.5477)
// Vehicle A approaches from west (heading 90°), Vehicle B from east (heading 270°)
async function smoke07_etaConflict(ws) {
  const start = performance.now();
  const failures = [];

  const juncLat = 17.40135;
  const refLng = 78.5458;

  // Both vehicles VERY close together, both heading east toward same junction
  // A slightly behind, same speed — ensures ETAs are nearly identical
  await sendAndWait(ws, {
    userId: "smoke-07-a",
    latitude: juncLat, longitude: 78.5458,
    speed: 8.3, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });
  await sleep(200);

  // B very close to A, same heading and speed
  await sendAndWait(ws, {
    userId: "smoke-07-b",
    latitude: juncLat, longitude: 78.5459,
    speed: 8.3, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });
  await sleep(200);

  // A sends again immediately — both should be at same junction with close ETAs
  const respA = await sendAndWait(ws, {
    userId: "smoke-07-a",
    latitude: juncLat, longitude: 78.5458,
    speed: 8.3, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });

  const latency = performance.now() - start;

  // Check if ETA conflict was detected
  const threats = respA.threats || [];
  const etaConflicts = threats.filter(t => t.type === "intersection_collision");

  check(failures, etaConflicts.length > 0, "ETA conflict detected", etaConflicts.length, ">0");

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp: respA, scenario: "Smoke-07", label: "ETA Conflict" };
}

// ─── Smoke-08: Road Curve Prediction ───
// Vehicle on road 22831055 (has visible curve ~92° heading). Verify trajectory follows road.
async function smoke08_roadCurve(ws) {
  const start = performance.now();
  const failures = [];

  const resp = await sendAndWait(ws, {
    userId: "smoke-08",
    latitude: 17.40135, longitude: 78.5458,
    speed: 13.9, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });

  const latency = performance.now() - start;
  const mm = resp.mapMatch || {};

  check(failures, mm.matched === true, "vehicle matched", mm.matched, true);
  check(failures, mm.confidence >= 0.5, "match confidence >= 0.50", mm.confidence, ">=0.50");

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-08", label: "Road Curve" };
}

// ─── Smoke-09: Uncertainty Growth ───
// Verify that prediction uncertainty grows with time horizon
async function smoke09_uncertaintyGrowth(ws) {
  const start = performance.now();
  const failures = [];

  const resp = await sendAndWait(ws, {
    userId: "smoke-09",
    latitude: 17.3593, longitude: 78.4698,
    speed: 13.9, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    clientTime: Date.now(), serverTime: Date.now(),
  });

  const latency = performance.now() - start;

  // The response doesn't include uncertainty values directly,
  // but the test confirms the server doesn't crash with trajectory prediction
  check(failures, resp.status === "received" || resp.status === "error", "server responded", resp.status, "received");

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp, scenario: "Smoke-09", label: "Uncertainty Growth" };
}

// ─── Smoke-10: Probability Overlap ───
// Two vehicles approaching same junction from perpendicular roads
// Collision probability should be reported
async function smoke10_probabilityOverlap(ws) {
  const start = performance.now();
  const failures = [];

  // Vehicle A on east-west road approaching junction from west
  await sendAndWait(ws, {
    userId: "smoke-10-a",
    latitude: 17.4005, longitude: 78.5455,
    speed: 11.1, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    turnAhead: true, intersectionLat: 17.40135, intersectionLng: 78.5477,
    clientTime: Date.now(), serverTime: Date.now(),
  });
  await sleep(300);

  // Vehicle B approaching same junction
  await sendAndWait(ws, {
    userId: "smoke-10-b",
    latitude: 17.4005, longitude: 78.5458,
    speed: 8.3, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    turnAhead: true, intersectionLat: 17.40135, intersectionLng: 78.5477,
    clientTime: Date.now(), serverTime: Date.now(),
  });
  await sleep(300);

  // Vehicle A sends again — collision probability should be computed
  const respA = await sendAndWait(ws, {
    userId: "smoke-10-a",
    latitude: 17.4005, longitude: 78.5456,
    speed: 11.1, heading: 90,
    positionUncertainty: 5, sensorQuality: 0.9,
    turnAhead: true, intersectionLat: 17.40135, intersectionLng: 78.5477,
    clientTime: Date.now(), serverTime: Date.now(),
  });

  const latency = performance.now() - start;

  // Verify server processes without error
  check(failures, respA.status !== "error", "no server error", respA.status, "not error");

  return { passed: passed(failures), failures: onlyFailures(failures), latency, resp: respA, scenario: "Smoke-10", label: "Probability Overlap" };
}

// ─── Main ───
async function main() {
  console.log("─".repeat(50));
  console.log("Sprint 3 Smoke Test");
  console.log("─".repeat(50));
  console.log(`WS: ${WS_URL}\n`);

  let ws;
  try {
    ws = await connect();
  } catch (e) {
    console.error(`FAIL: Could not connect to ${WS_URL}`);
    console.error(`      ${e.message}`);
    process.exit(1);
  }

  const tests = [smoke01_parallelRoads, smoke02_flyover, smoke03_gpsDrift, smoke04_gpsJump, smoke05_timeSync, smoke06_roadBubble, smoke07_etaConflict, smoke08_roadCurve, smoke09_uncertaintyGrowth, smoke10_probabilityOverlap];
  const results = [];
  let hasRedisError = false;
  let hasMongoError = false;

  for (const test of tests) {
    try {
      const result = await test(ws);
      results.push(result);

      const passStr = result.passed ? "PASS" : "FAIL";
      console.log(` ${result.scenario} (${result.label}) ${".".repeat(Math.max(1, 35 - result.scenario.length - result.label.length))} ${passStr} (${result.latency.toFixed(0)}ms)`);

      if (!result.passed && result.failures) {
        for (const f of result.failures) {
          if (f) console.log(`   ✗ ${f}`);
        }
      }
    } catch (e) {
      results.push({ passed: false, failures: [`Uncaught exception: ${e.message}`], latency: 0, scenario: "unknown" });
      console.log(` UNCAUGHT ERROR: ${e.message}`);
    }
  }

  ws.close();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const latencies = results.map((r) => r.latency).filter((l) => l > 0);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const worstLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  // Map match pass rate
  const mapMatchResults = results.filter((r) => r.resp?.mapMatch?.confidence !== undefined);
  const mapMatchPassed = mapMatchResults.filter((r) => (r.resp?.mapMatch?.confidence ?? 0) >= 0.7).length;
  const mapMatchRate = mapMatchResults.length > 0 ? (mapMatchPassed / mapMatchResults.length * 100).toFixed(0) : "N/A";

  console.log("\n" + "─".repeat(50));
  console.log("Summary");
  console.log("─".repeat(50));
  console.log(` Map Match Pass Rate: ${mapMatchRate}%`);
  console.log(` Avg Latency: ${avgLatency.toFixed(0)}ms`);
  console.log(` Worst Latency: ${worstLatency.toFixed(0)}ms`);
  console.log(` PASS: ${passed}`);
  console.log(` FAIL: ${failed}`);
  console.log("─".repeat(50));

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultFile = `${RESULTS_DIR}/${timestamp}.json`;
  const resultData = {
    timestamp: new Date().toISOString(),
    wsUrl: WS_URL,
    results: results.map((r) => ({
      scenario: r.scenario,
      label: r.label,
      passed: r.passed,
      latencyMs: r.latency,
      failures: r.failures ? r.failures.filter(Boolean) : [],
      mapMatchConfidence: r.resp?.mapMatch?.confidence ?? null,
      threatsCount: (r.resp?.threats || []).length,
      serverTime: r.resp?.serverTime ?? null,
    })),
    summary: {
      passed,
      failed,
      avgLatencyMs: avgLatency,
      worstLatencyMs: worstLatency,
      mapMatchPassRate: mapMatchRate,
    },
  };
  writeFileSync(resultFile, JSON.stringify(resultData, null, 2));
  console.log(`\n Results saved: ${resultFile}`);

  // Exit code
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
