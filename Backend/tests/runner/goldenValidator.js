class GoldenValidator {
  constructor() {
    this.goldenIds = ["G-01", "G-02", "G-03", "G-04", "G-05", "G-06", "G-07", "G-08", "G-09", "G-10"];
    this.results = null;
  }

  validate(metrics, scenarioResults) {
    const gates = [];

    // Check each golden scenario
    for (const gid of this.goldenIds) {
      const scenario = scenarioResults.find((r) => r.scenarioId === gid);
      if (!scenario) {
        gates.push({ id: gid, name: gid, passed: false, reason: "Scenario not run" });
        continue;
      }
      gates.push({
        id: gid,
        name: gid,
        passed: scenario.passed,
        alerts: scenario.alerts.length,
        reason: scenario.passed ? "OK" : "Failed assertions",
      });
    }

    // Global kill gates
    gates.push({
      id: "PRECISION",
      name: "Precision > 85%",
      passed: metrics.precision >= 0.85,
      actual: (metrics.precision * 100).toFixed(1) + "%",
    });
    gates.push({
      id: "RECALL",
      name: "Recall > 80%",
      passed: metrics.recall >= 0.80,
      actual: (metrics.recall * 100).toFixed(1) + "%",
    });
    gates.push({
      id: "FPR",
      name: "False Positive Rate < 15%",
      passed: metrics.falsePositiveRate <= 0.15,
      actual: (metrics.falsePositiveRate * 100).toFixed(1) + "%",
    });
    gates.push({
      id: "CALIBRATION",
      name: "Calibration Error < 15%",
      passed: metrics.calibrationError <= 0.15,
      actual: (metrics.calibrationError * 100).toFixed(1) + "%",
    });

    const allPassed = gates.every((g) => g.passed);
    this.results = { gates, allPassed };
    return this.results;
  }
}

export default GoldenValidator;
