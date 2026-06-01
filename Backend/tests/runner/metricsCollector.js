class MetricsCollector {
  constructor() {
    this.scenarioResults = [];
  }

  record(scenarioResults, expected) {
    this.scenarioResults.push({ ...scenarioResults, expected });
  }

  getAggregate() {
    const sr = this.scenarioResults;
    if (sr.length === 0) return {};

    let tp = 0, fp = 0, tn = 0, fn = 0;
    let totalWarningTime = 0;
    let alertCount = 0;
    let scenarioFirstAlertTimes = [];
    let totalCalibrationError = 0;
    let calibrationPairs = 0;
    let totalEtaError = 0;
    let etaCount = 0;
    let totalProcessingMs = 0;
    let allLatencies = [];
    let correctMatches = 0;
    let totalMatches = 0;
    let mapMatchErrors = [];

    for (const r of sr) {
      const exp = r.expected;
      const hasAlert = r.alerts.length > 0;
      const shouldAlert = exp.alert === true;

      if (hasAlert && shouldAlert) tp++;
      else if (hasAlert && !shouldAlert) fp++;
      else if (!hasAlert && !shouldAlert) tn++;
      else if (!hasAlert && shouldAlert) fn++;

      if (hasAlert) {
        alertCount += r.alerts.length;
        const firstTime = Math.min(...r.alerts.map((a) => a.time));
        scenarioFirstAlertTimes.push(firstTime);
        totalWarningTime += firstTime;
      }

      // Confidence calibration
      for (const a of r.alerts) {
        if (a.confidence > 0) {
          calibrationPairs++;
          totalCalibrationError += Math.abs(a.confidence - (shouldAlert ? 1.0 : 0.0));
        }
      }

      // ETA errors (from scenario specifics — approximated)
      if (exp.etaError !== undefined && r.alerts.length > 0) {
        totalEtaError += exp.etaError;
        etaCount++;
      }

      // Processing times
      totalProcessingMs += r.latencies.reduce((a, b) => a + b, 0);
      allLatencies.push(...r.latencies);

      // Map match accuracy
      for (const mm of r.mapMatches) {
        totalMatches++;
        if (mm.matched && mm.confidence >= 0.5) correctMatches++;
      }
    }

    const sortedLatencies = [...allLatencies].sort((a, b) => a - b);
    const avgLatency = allLatencies.length > 0 ? totalProcessingMs / allLatencies.length : 0;

    return {
      total: sr.length,
      tp,
      fp,
      tn,
      fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
      falsePositiveRate: fp + tn > 0 ? fp / (fp + tn) : 0,
      trueNegativeRate: fp + tn > 0 ? tn / (fp + tn) : 0,
      accuracy: sr.length > 0 ? (tp + tn) / sr.length : 0,
      f1Score: tp + fp + fn > 0 ? 2 * tp / (2 * tp + fp + fn) : 0,
      avgWarningTime: scenarioFirstAlertTimes.length > 0
        ? scenarioFirstAlertTimes.reduce((a, b) => a + b, 0) / scenarioFirstAlertTimes.length
        : 0,
      minWarningTime: scenarioFirstAlertTimes.length > 0 ? Math.min(...scenarioFirstAlertTimes) : 0,
      maxWarningTime: scenarioFirstAlertTimes.length > 0 ? Math.max(...scenarioFirstAlertTimes) : 0,
      alertCount,
      calibrationError: calibrationPairs > 0 ? totalCalibrationError / calibrationPairs : 0,
      etaErrorRMS: etaCount > 0 ? Math.sqrt(totalEtaError / etaCount) : 0,
      avgProcessingTimeMs: avgLatency,
      p50ProcessingTimeMs: sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] : 0,
      p95ProcessingTimeMs: sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] : 0,
      p99ProcessingTimeMs: sortedLatencies.length > 0 ? sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] : 0,
      mapMatchAccuracy: totalMatches > 0 ? correctMatches / totalMatches : 0,
      totalMapMatches: totalMatches,
    };
  }

  getCalibrationCurve() {
    // Group alerts by confidence bucket and compute actual precision
    const buckets = {};
    for (const r of this.scenarioResults) {
      for (const a of r.alerts) {
        const bucket = Math.floor(a.confidence * 10) * 10; // 0-10%, 10-20%, etc.
        if (!buckets[bucket]) buckets[bucket] = { count: 0, correct: 0 };
        buckets[bucket].count++;
        if (r.expected.alert === true) buckets[bucket].correct++;
      }
    }
    return Object.entries(buckets).map(([bucket, data]) => ({
      bucket: `${bucket}-${parseInt(bucket) + 10}%`,
      count: data.count,
      accuracy: data.correct / data.count,
    }));
  }

  getGroupBreakdown(group) {
    const filtered = this.scenarioResults.filter((r) => r.group === group);
    const collector = new MetricsCollector();
    for (const r of filtered) collector.record(r, r.expected);
    return collector.getAggregate();
  }
}

export default MetricsCollector;
