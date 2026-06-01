import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

import ScenarioEngine from "./scenarioEngine.js";
import MetricsCollector from "./metricsCollector.js";
import ReportGenerator from "./reportGenerator.js";
import GoldenValidator from "./goldenValidator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENARIO_PATH = resolve(__dirname, "../scenarios/scenario_spec_v1.json");
const REPORTS_DIR = resolve(__dirname, "../reports");

const args = process.argv.slice(2);
const RUN_ALL = args.includes("--all") || args.includes("--full");
const RUN_GOLDEN = args.includes("--golden");
const RUN_SPRINT3 = args.includes("--sprint3");
const RUN_GROUP = args.filter((a) => a.startsWith("--group=")).map((a) => a.split("=")[1]);
const RUN_REDTEAM = args.includes("--redteam");

function loadScenarios() {
  const raw = JSON.parse(readFileSync(SCENARIO_PATH, "utf-8"));
  const scenarios = [];
  const groups = raw.scenarios || {};

  const goldenList = groups.golden || [];
  const groupA = groups.groupA_mustAlert || [];
  const groupB = groups.groupB_mustNotAlert || [];
  const groupC = groups.groupC_degradedData || [];
  const groupD = groups.groupD_scale || [];
  const groupE = groups.groupE_redTeam || [];

  if (RUN_GOLDEN) {
    scenarios.push(...goldenList.map((s) => ({ ...s, group: "GOLDEN" })));
  }
  if (RUN_SPRINT3) {
    // Sprint 3 smoke tests are run separately via smoke_test.mjs
    // Include them here as a quick check
    scenarios.push(...goldenList.slice(0, 3).map((s) => ({ ...s, group: "GOLDEN" })));
  }
  if (RUN_REDTEAM) {
    scenarios.push(...groupE.map((s) => ({ ...s, group: "E" })));
  }
  if (RUN_ALL) {
    scenarios.push(...goldenList.map((s) => ({ ...s, group: "GOLDEN" })));
    scenarios.push(...groupA.map((s) => ({ ...s, group: "A" })));
    scenarios.push(...groupB.map((s) => ({ ...s, group: "B" })));
    scenarios.push(...groupC.map((s) => ({ ...s, group: "C" })));
    scenarios.push(...groupE.map((s) => ({ ...s, group: "E" })));
    // Scale tests separately (D group)
  }
  if (RUN_GROUP.length > 0) {
    const groupMap = { A: groupA, B: groupB, C: groupC, D: groupD, E: groupE, GOLDEN: goldenList };
    for (const g of RUN_GROUP) {
      if (groupMap[g]) scenarios.push(...groupMap[g].map((s) => ({ ...s, group: g })));
    }
  }

  return scenarios;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Safety App — Full Test Harness");
  console.log("=".repeat(60));

  const scenarios = loadScenarios();
  if (scenarios.length === 0) {
    console.error("No scenarios selected. Use --all, --golden, --redteam, --group=A, etc.");
    process.exit(1);
  }

  if (RUN_ALL) console.log(`Running all ${scenarios.length} scenarios...`);
  else if (RUN_GOLDEN) console.log(`Running Golden Dataset (${scenarios.length} scenarios)...`);
  else if (RUN_REDTEAM) console.log(`Running Red Team (${scenarios.length} scenarios)...`);
  else if (RUN_GROUP.length > 0) console.log(`Running groups ${RUN_GROUP.join(", ")} (${scenarios.length} scenarios)...`);

  console.log("");

  const engine = new ScenarioEngine();
  const metrics = new MetricsCollector();
  const results = [];
  const scaleResults = [];

  for (const scenario of scenarios) {
    if (scenario.group === "D") {
      // Scale tests — run separately
      scaleResults.push(scenario);
      continue;
    }

    process.stdout.write(`  ${scenario.id || "???"} ${(scenario.name || "").substring(0, 50).padEnd(52)} `);

    try {
      const result = await engine.runScenario(scenario);
      result.scenarioId = scenario.id;
      result.name = scenario.name;
      result.group = scenario.group;
      results.push(result);

      const passStr = result.passed ? "PASS" : "FAIL";
      const alertStr = result.alerts.length > 0 ? ` (${result.alerts.length} alerts)` : "";
      const errorStr = result.errors.length > 0 ? ` (${result.errors.length} errors)` : "";
      process.stdout.write(`${passStr}${alertStr}${errorStr}\n`);

      metrics.record(result, scenario.expected || {});
    } catch (e) {
      process.stdout.write(`ERROR: ${e.message}\n`);
      results.push({
        scenarioId: scenario.id,
        name: scenario.name,
        group: scenario.group,
        passed: false,
        alerts: [],
        errors: [{ message: e.message }],
        latencies: [],
        mapMatches: [],
      });
    }
  }

  // Run scale tests
  if (scaleResults.length > 0) {
    console.log("\n── Scale Tests ──");
    for (const scenario of scaleResults) {
      process.stdout.write(`  ${scenario.id} ${(scenario.name || "").substring(0, 50).padEnd(52)} `);
      try {
        const result = await engine.runScenario(scenario);
        result.scenarioId = scenario.id;
        result.name = scenario.name;
        result.group = scenario.group;
        scaleResults.push(result);
        process.stdout.write(result.passed ? "PASS\n" : "FAIL\n");
      } catch (e) {
        process.stdout.write(`ERROR: ${e.message}\n`);
      }
    }
  }

  console.log("\n── Aggregate Metrics ──");
  const agg = metrics.getAggregate();
  console.log(`  Precision:            ${(agg.precision * 100).toFixed(1)}%`);
  console.log(`  Recall:               ${(agg.recall * 100).toFixed(1)}%`);
  console.log(`  False Positive Rate:  ${(agg.falsePositiveRate * 100).toFixed(1)}%`);
  console.log(`  Accuracy:             ${(agg.accuracy * 100).toFixed(1)}%`);
  console.log(`  F1 Score:             ${(agg.f1Score * 100).toFixed(1)}%`);
  console.log(`  Avg Warning Time:     ${agg.avgWarningTime.toFixed(2)}s`);
  console.log(`  Calibration Error:    ${(agg.calibrationError * 100).toFixed(1)}%`);
  console.log(`  Map Match Accuracy:   ${(agg.mapMatchAccuracy * 100).toFixed(1)}%`);
  console.log(`  Avg Processing Time:  ${agg.avgProcessingTimeMs.toFixed(0)}ms`);
  console.log(`  P95 Latency:          ${agg.p95ProcessingTimeMs.toFixed(0)}ms`);

  // Golden Dataset validation
  const goldenScenarios = results.filter((r) => r.scenarioId && r.scenarioId.startsWith("G-"));
  console.log(`\n── Golden Dataset ──`);
  for (const g of goldenScenarios) {
    console.log(`  ${g.scenarioId}: ${g.passed ? "PASS" : "FAIL"} (${g.alerts.length} alerts)`);
  }

  const validator = new GoldenValidator();
  const goldenResult = validator.validate(agg, results);
  console.log(`\n── Kill Gates ──`);
  for (const gate of goldenResult.gates) {
    console.log(`  ${gate.id}: ${gate.passed ? "✅" : "❌"} ${gate.actual || gate.reason || ""}`);
  }

  // Calibration curve
  const curve = metrics.getCalibrationCurve();
  if (curve.length > 0) {
    console.log(`\n── Confidence Calibration ──`);
    for (const b of curve) {
      const bar = "█".repeat(Math.round(b.accuracy * 20));
      console.log(`  ${b.bucket.padEnd(10)} ${bar} ${(b.accuracy * 100).toFixed(0)}% (n=${b.count})`);
    }
  }

  // Generate reports
  const reportGen = new ReportGenerator(REPORTS_DIR);
  reportGen.generate(agg, results, goldenResult);

  // Summary
  const passCount = results.filter((r) => r.passed).length;
  const failCount = results.filter((r) => !r.passed).length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`PASS: ${passCount}  FAIL: ${failCount}  TOTAL: ${results.length}`);
  console.log(`${"=".repeat(60)}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
