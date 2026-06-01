import { writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

class ReportGenerator {
  constructor(outputDir) {
    this.outputDir = outputDir;
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  }

  generate(metrics, scenarioResults, goldenResult) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    // JSON report
    const jsonReport = {
      timestamp: new Date().toISOString(),
      summary: {
        totalScenarios: scenarioResults.length,
        passed: scenarioResults.filter((r) => r.passed).length,
        failed: scenarioResults.filter((r) => !r.passed).length,
        precision: metrics.precision,
        recall: metrics.recall,
        falsePositiveRate: metrics.falsePositiveRate,
        accuracy: metrics.accuracy,
        f1Score: metrics.f1Score,
        avgWarningTime: metrics.avgWarningTime,
        calibrationError: metrics.calibrationError,
        etaErrorRMS: metrics.etaErrorRMS,
        avgProcessingTimeMs: metrics.avgProcessingTimeMs,
        p95ProcessingTimeMs: metrics.p95ProcessingTimeMs,
        mapMatchAccuracy: metrics.mapMatchAccuracy,
      },
      golden: goldenResult,
      calibrationCurve: metrics.getCalibrationCurve ? metrics.getCalibrationCurve() : [],
      scenarios: scenarioResults.map((r) => ({
        id: r.scenarioId,
        name: r.name,
        group: r.group,
        passed: r.passed,
        alerts: r.alerts.length,
        errors: r.errors.length,
        mapMatches: r.mapMatches.length,
        latencies: r.latencies.slice(0, 10),
      })),
    };

    writeFileSync(resolve(this.outputDir, `${timestamp}.json`), JSON.stringify(jsonReport, null, 2));

    // HTML report
    const passCount = resultSummary(jsonReport).passCount;
    const failCount = resultSummary(jsonReport).failCount;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Safety App — Test Harness Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    h1 { color: #58a6ff; margin-bottom: 20px; }
    h2 { color: #8b949e; margin: 24px 0 12px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
    .card .label { color: #8b949e; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    .card .value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card .value.green { color: #3fb950; }
    .card .value.yellow { color: #d29922; }
    .card .value.red { color: #f85149; }
    .card .value.blue { color: #58a6ff; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #30363d; color: #8b949e; font-size: 13px; }
    td { padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 13px; }
    .pass { color: #3fb950; font-weight: 700; }
    .fail { color: #f85149; font-weight: 700; }
    .gate-pass { background: #0b2e1c; }
    .gate-fail { background: #2e0b0b; }
    .golden { background: #0d2818; }
    .golden td:first-child { font-weight: 700; color: #58a6ff; }
  </style>
</head>
<body>
  <h1>Safety App — Test Harness Report</h1>
  <p style="color: #8b949e; margin-bottom: 24px;">${jsonReport.timestamp}</p>

  <h2>Summary</h2>
  <div class="summary">
    <div class="card"><div class="label">Precision</div><div class="value ${metrics.precision >= 0.85 ? 'green' : 'red'}">${(metrics.precision * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Recall</div><div class="value ${metrics.recall >= 0.8 ? 'green' : 'red'}">${(metrics.recall * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">False Positive Rate</div><div class="value ${metrics.falsePositiveRate <= 0.15 ? 'green' : 'red'}">${(metrics.falsePositiveRate * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Accuracy</div><div class="value ${metrics.accuracy >= 0.8 ? 'green' : 'yellow'}">${(metrics.accuracy * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">F1 Score</div><div class="value blue">${(metrics.f1Score * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Avg Warning Time</div><div class="value blue">${metrics.avgWarningTime.toFixed(1)}s</div></div>
    <div class="card"><div class="label">Calibration Error</div><div class="value ${metrics.calibrationError <= 0.15 ? 'green' : 'red'}">${(metrics.calibrationError * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">Map Match Accuracy</div><div class="value ${metrics.mapMatchAccuracy >= 0.85 ? 'green' : 'yellow'}">${(metrics.mapMatchAccuracy * 100).toFixed(1)}%</div></div>
    <div class="card"><div class="label">P95 Latency</div><div class="value blue">${metrics.p95ProcessingTimeMs.toFixed(0)}ms</div></div>
    <div class="card"><div class="label">Scenarios</div><div class="value blue">${passCount}/${jsonReport.summary.totalScenarios}</div></div>
  </div>

  <h2>Golden Dataset</h2>
  <table>
    <tr><th>ID</th><th>Status</th><th>Alerts</th></tr>
    ${jsonReport.scenarios.filter(function(s) { return s.id && s.id.startsWith('G-'); }).map(function(s) { return '<tr class="golden"><td>' + s.id + '</td><td class="' + (s.passed ? 'pass' : 'fail') + '">' + (s.passed ? 'PASS' : 'FAIL') + '</td><td>' + s.alerts + '</td></tr>'; }).join('')}
  </table>

  <h2>Kill Gates</h2>
  <table>
    <tr><th>Gate</th><th>Status</th><th>Detail</th></tr>
    ${(jsonReport.golden && jsonReport.golden.gates ? jsonReport.golden.gates : []).map(function(g) { return '<tr class="' + (g.passed ? 'gate-pass' : 'gate-fail') + '"><td>' + (g.id || g.name) + '</td><td class="' + (g.passed ? 'pass' : 'fail') + '">' + (g.passed ? 'PASS' : 'FAIL') + '</td><td>' + (g.actual || g.reason || '') + '</td></tr>'; }).join('')}
  </table>

  <h2>All Scenarios</h2>
  <table>
    <tr><th>ID</th><th>Name</th><th>Group</th><th>Status</th><th>Alerts</th><th>Errors</th></tr>
    ${jsonReport.scenarios.map(function(s) { return '<tr><td>' + (s.id || '') + '</td><td>' + (s.name || '') + '</td><td>' + (s.group || '') + '</td><td class="' + (s.passed ? 'pass' : 'fail') + '">' + (s.passed ? 'PASS' : 'FAIL') + '</td><td>' + s.alerts + '</td><td>' + s.errors + '</td></tr>'; }).join('')}
  </table>
</body>
</html>`;

    writeFileSync(resolve(this.outputDir, `${timestamp}.html`), html);
    console.log(`📊 Report saved to ${this.outputDir}/${timestamp}.html`);
    console.log(`📊 Data saved to ${this.outputDir}/${timestamp}.json`);
  }
}

function resultSummary(report) {
  return { passCount: report.summary.passed, failCount: report.summary.failed };
}

export default ReportGenerator;
