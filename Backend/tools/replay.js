#!/usr/bin/env node
// tools/replay.js — Replay a recorded session against the server and compare results
// Usage: node tools/replay.js <path-to-session.json> [wsUrl]

import WebSocket from "ws";
import { readFileSync, existsSync } from "fs";
import { createHash } from "crypto";

const WS_URL = process.argv[3] || "ws://localhost:5001?token=dev-token";
const SESSION_PATH = process.argv[2];

if (!SESSION_PATH || !existsSync(SESSION_PATH)) {
  console.error("Usage: node tools/replay.js <session.json> [wsUrl]");
  process.exit(1);
}

const session = JSON.parse(readFileSync(SESSION_PATH, "utf-8"));
const snapshots = session.snapshots || [];

console.log("=".repeat(60));
console.log("Session Replay Tool");
console.log("=".repeat(60));
console.log(`Session:     ${session.sessionId}`);
console.log(`App Version: ${session.appVersion}`);
console.log(`Backend:     ${session.backendVersion}`);
console.log(`Model:       ${session.modelVersion}`);
console.log(`Duration:    ${session.durationSec}s`);
console.log(`Snapshots:   ${session.snapshotCount} (${snapshots.length} in file)`);
console.log(`Alerts:      ${session.summary?.totalAlerts || 0}`);

const threatSnapshots = snapshots.filter((s) => s.type === "threat");
console.log(`Threat frames: ${threatSnapshots.length}`);
console.log("");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function deterministicThreatId(type, roadId, otherId, time) {
  const raw = `${type}|${roadId || "none"}|${otherId || "none"}|${Math.floor(time || 0)}`;
  return createHash("sha256").update(raw).digest("hex").substring(0, 12);
}

async function main() {
  const ws = await new Promise((resolve, reject) => {
    const w = new WebSocket(WS_URL);
    w.on("open", () => resolve(w));
    w.on("error", (e) => reject(e));
    setTimeout(() => reject(new Error("WS connect timeout")), 5000);
  });
  console.log("Connected to server\n");

  let totalDiffs = 0;
  let threatChanges = 0;
  let replayCount = 0;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap.type === "heartbeat") {
      replayCount++;
      continue;
    }

    const sentPayload = snap.sent;
    const originalResponse = snap.received;
    if (!sentPayload || !originalResponse) {
      replayCount++;
      continue;
    }

    let replayedResponse;
    try {
      replayedResponse = await sendAndWait(ws, sentPayload);
    } catch (e) {
      console.log(`[t=${snap.t.toFixed(1)}s] ⚠ SEND FAILED: ${e.message}`);
      totalDiffs++;
      replayCount++;
      continue;
    }

    replayCount++;

    // Compare
    const diffs = compareResponses(originalResponse, replayedResponse, sentPayload);
    if (diffs.length > 0) {
      totalDiffs++;
      const origCount = (originalResponse.threats || []).length;
      const replCount = (replayedResponse.threats || []).length;
      if (origCount !== replCount) threatChanges++;
      console.log(`[t=${snap.t.toFixed(1)}s] DIFF: ${diffs.join("; ")}`);
    }

    if (i < snapshots.length - 1) {
      const nextT = snapshots[i + 1].t;
      const dt = Math.max(0, (nextT - snap.t) * 150);
      await sleep(Math.min(dt, 300));
    }
  }

  ws.close();

  console.log("\n" + "=".repeat(60));
  console.log("Replay Summary");
  console.log("=".repeat(60));
  console.log(`  Snapshots replayed: ${replayCount}`);
  console.log(`  Snapshots with diffs: ${totalDiffs}`);
  console.log(`  Threat count changes: ${threatChanges}`);

  if (totalDiffs === 0) {
    console.log("\n  ✅ Replay matches original session perfectly");
  } else {
    console.log(`\n  ⚠ ${totalDiffs} snapshot(s) differ from original`);
  }
  console.log("");
}

function sendAndWait(ws, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Response timeout")), timeoutMs);
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        clearTimeout(timer);
        ws.removeListener("message", handler);
        resolve(parsed);
      } catch {}
    };
    ws.on("message", handler);
    ws.send(JSON.stringify(payload));
  });
}

function compareResponses(original, replayed, sentPayload) {
  const diffs = [];
  if (!original || !replayed) return [];

  const origThreats = original.threats || [];
  const replThreats = replayed.threats || [];

  // Compare threat IDs
  const origIds = origThreats.map((t) => t.threatId || deterministicThreatId(t.type, null, t.id, t.time_s)).sort();
  const replIds = replThreats.map((t) => t.threatId || deterministicThreatId(t.type, null, t.id, t.time_s)).sort();

  if (JSON.stringify(origIds) !== JSON.stringify(replIds)) {
    diffs.push(`threat IDs mismatch (${origIds.length} vs ${replIds.length})`);
    // Show missing / extra
    for (const id of origIds) if (!replIds.includes(id)) diffs.push(`  missing: ${id}`);
    for (const id of replIds) if (!origIds.includes(id)) diffs.push(`  extra: ${id}`);
  }

  // Compare count
  if (origThreats.length !== replThreats.length) {
    diffs.push(`count: ${origThreats.length} → ${replThreats.length}`);
  }

  // Compare individual threat fields
  const minLen = Math.min(origThreats.length, replThreats.length);
  for (let j = 0; j < minLen; j++) {
    const o = origThreats[j];
    const r = replThreats[j];
    if (o.type !== r.type) diffs.push(`threat[${j}] type: ${o.type} → ${r.type}`);
    if (Math.abs((o.collisionProbability || 0) - (r.collisionProbability || 0)) > 0.15) {
      diffs.push(`threat[${j}] prob: ${(o.collisionProbability || 0).toFixed(2)} → ${(r.collisionProbability || 0).toFixed(2)}`);
    }
    if (o.alertClass !== r.alertClass) diffs.push(`threat[${j}] class: ${o.alertClass} → ${r.alertClass}`);
  }

  return diffs;
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
