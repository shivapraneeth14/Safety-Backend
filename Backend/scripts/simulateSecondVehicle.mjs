// Helper script: connect a single simulated vehicle approaching a known intersection
// Usage: node scripts/simulateSecondVehicle.mjs [speed_mps] [heading_deg]
// Defaults: speed=10 m/s (36 km/h), heading=90 (east), from east side

import WebSocket from 'ws';
import http from 'http';

const HTTP_URL = 'http://localhost:5001';
const WS_BASE = 'ws://localhost:5001';
const INTERSECTION = { lat: 17.3849, lng: 78.4870 };

const SPEED = parseFloat(process.argv[2] || '10');
const HEADING = parseFloat(process.argv[3] || '90');
// Direction determines starting position relative to intersection
const DIRECTION = process.argv[4] || 'east';

let ACCESS_TOKEN = null;

async function getAccessToken() {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ loginname: 'testuser', password: 'testpass123' });
    const options = {
      hostname: 'localhost', port: 5001, path: '/api/Login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { const data = JSON.parse(body); resolve(data.accessToken || null); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// Starting position based on direction
function getStartPos() {
  switch (DIRECTION) {
    case 'west': return { lat: INTERSECTION.lat, lng: INTERSECTION.lng - 0.008 }; // from west
    case 'east': return { lat: INTERSECTION.lat, lng: INTERSECTION.lng + 0.008 }; // from east
    case 'north': return { lat: INTERSECTION.lat + 0.008, lng: INTERSECTION.lng };
    case 'south': return { lat: INTERSECTION.lat - 0.008, lng: INTERSECTION.lng };
    default: return { lat: INTERSECTION.lat, lng: INTERSECTION.lng - 0.008 };
  }
}

const startPos = getStartPos();
const startDist = 800; // ~800m from intersection at this offset

const vehicleId = `sim-second-${Date.now()}`;
const startTime = Date.now();

async function run() {
  ACCESS_TOKEN = await getAccessToken();
  const wsUrl = ACCESS_TOKEN ? `${WS_BASE}?token=${ACCESS_TOKEN}` : WS_BASE;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`✅ ${vehicleId} connected`);
    console.log(`Speed: ${SPEED} m/s (${(SPEED * 3.6).toFixed(0)} km/h), Heading: ${HEADING}°`);
    console.log(`Starting from ${DIRECTION} of intersection\n`);

    let step = 0;
    const timer = setInterval(() => {
      step++;
      const elapsed = (Date.now() - startTime) / 1000;
      const distTraveled = SPEED * step;
      const fraction = Math.min(1, distTraveled / startDist);
      const distToTurn = Math.max(0, startDist - distTraveled);
      const turnAhead = distToTurn <= 40 && distToTurn >= 2;

      let lat, lng;
      lat = startPos.lat + (INTERSECTION.lat - startPos.lat) * fraction;
      lng = startPos.lng + (INTERSECTION.lng - startPos.lng) * fraction;

      ws.send(JSON.stringify({
        userId: vehicleId, latitude: lat, longitude: lng,
        speed: SPEED, heading: HEADING,
        gyro: { x: 0, y: 0, z: 0 },
        turnAhead, turnType: 'left_turn', turnDistance: distToTurn,
        intersectionLat: INTERSECTION.lat, intersectionLng: INTERSECTION.lng,
        connectivity: 'wifi', timestamp: new Date().toISOString(),
      }));

      const indicator = turnAhead ? '🔴 TURN' : '    ';
      console.log(`[${elapsed.toFixed(1)}s] ${distToTurn.toFixed(0)}m from turn ${indicator}`);

      if (step > startDist / SPEED + 3) {
        clearInterval(timer);
        ws.close();
        process.exit(0);
      }
    }, 1000);
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.threats?.length > 0) {
      msg.threats.forEach(t => {
        console.log(`🚨 THREAT: ${t.type} — ${t.message} [severity: ${t.severity || 1}]`);
      });
    }
  });

  ws.on('error', (e) => console.error('❌ WS error:', e.message));
}

run().catch(e => { console.error(e); process.exit(1); });
