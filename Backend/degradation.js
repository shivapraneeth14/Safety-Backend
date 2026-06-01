function computePredictionUncertainty(params) {
  const {
    timeHorizon = 0,
    speedMs = 0,
    sensorQuality = 0.8,
    mapMatchConfidence = 0,
    roadConfidence = 0.5,
    networkRttMs = 50,
    positionUncertainty = 5,
    timeSinceLastUpdateMs = 0,
    kalmanVelocityUncertainty = 0,
  } = params;

  let base = positionUncertainty || 5;

  const velocityError = speedMs * 0.15;
  base += velocityError * timeHorizon;

  const headingErrorRate = 1.2;
  base += 0.5 * headingErrorRate * timeHorizon * timeHorizon;

  const sensorFactor = sensorQuality > 0.01 ? 1.0 / sensorQuality : 2.0;
  base *= Math.min(sensorFactor, 3.0);

  if (mapMatchConfidence > 0) {
    base += (1 - mapMatchConfidence) * 15;
  }
  base += (1 - roadConfidence) * 10;

  if (networkRttMs > 100) {
    base += (networkRttMs / 1000) * speedMs * 0.3;
  }

  if (timeSinceLastUpdateMs > 2000) {
    const staleFactor = (timeSinceLastUpdateMs - 2000) / 1000;
    base += staleFactor * speedMs * 0.5;
  }

  base += kalmanVelocityUncertainty * timeHorizon;

  return Math.max(base, 1.0);
}

function computeCollisionRadius(baseRadius, uncertaintySelf, uncertaintyOther, timeHorizon) {
  const uncertaintyRadius = uncertaintySelf + uncertaintyOther;
  const timeScaledRadius = baseRadius + uncertaintyRadius;
  return timeScaledRadius;
}

function computeOverlapProbability(distanceMeters, uncertaintySelf, uncertaintyOther) {
  const combined = uncertaintySelf + uncertaintyOther;
  if (combined <= 0) return distanceMeters <= 2.5 ? 1.0 : 0.0;
  if (distanceMeters >= combined) return 0.0;
  return 1.0 - (distanceMeters / combined);
}

function computeAlertConfidence(collisionProbability, matchConfidence, sensorQuality, roadConfidence, vehicleStateConfidence) {
  const reliabilityScore = ((matchConfidence || 0.5) + (roadConfidence || 0.5) + (vehicleStateConfidence || 0.5)) / 3;
  const confidence = collisionProbability * 0.8 + reliabilityScore * 0.2;
  return Math.max(0, Math.min(1.0, confidence));
}

function classifyStaleness(lastTimestamp) {
  if (!lastTimestamp) return "expired";
  const age = Date.now() - lastTimestamp;
  if (age < 2000) return "fresh";
  if (age < 5000) return "degraded";
  if (age < 10000) return "stale";
  return "expired";
}

const ALERT_THRESHOLDS = {
  critical: { minConfidence: 0.8, sound: true, vibration: true, banner: true },
  high: { minConfidence: 0.5, sound: false, vibration: true, banner: true },
  monitor: { minConfidence: 0.3, sound: false, vibration: false, banner: false },
  ignore: { minConfidence: 0, sound: false, vibration: false, banner: false },
};

function classifyAlert(confidence, mode = "balanced") {
  const thresholds = {
    conservative: { critical: 0.7, high: 0.4, monitor: 0.2 },
    balanced: { critical: 0.8, high: 0.5, monitor: 0.3 },
    minimal: { critical: 0.9, high: 0.7, monitor: 0.5 },
  };

  const t = thresholds[mode] || thresholds.balanced;

  if (confidence >= t.critical) return "critical";
  if (confidence >= t.high) return "high";
  if (confidence >= t.monitor) return "monitor";
  return "ignore";
}

export {
  computePredictionUncertainty,
  computeCollisionRadius,
  computeOverlapProbability,
  computeAlertConfidence,
  classifyStaleness,
  classifyAlert,
  ALERT_THRESHOLDS,
};
