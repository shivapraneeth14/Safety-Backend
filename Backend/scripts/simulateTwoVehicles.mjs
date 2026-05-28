import WebSocket from 'ws';
import http from 'http';

const HTTP_URL = 'http://localhost:5001';
const WS_BASE = 'ws://localhost:5001';

// ─── SCENARIO DEFINITIONS ───
// FIX BUG #13: Multiple test scenarios

const SCENARIOS = {

  // Scenario 1 — Turn collision (perpendicular intersection)
  turn_collision: {
    name: 'Turn Collision (T-junction)',
    intersection: { lat: 17.3849, lng: 78.4870 },
    vehicles: [
      {
        id: 'sim-turn-1', startLat: 17.3842, startLng: 78.4870,
        heading: 0, speed: 8, distStart: 78, direction: 'north',
      },
      {
        id: 'sim-turn-2', startLat: 17.3849, startLng: 78.4862,
        heading: 90, speed: 8, distStart: 90, direction: 'east',
      },
    ],
  },

  // Scenario 2 — Rear end (same direction, different speeds)
  rear_end: {
    name: 'Rear End (same direction)',
    intersection: null,
    vehicles: [
      {
        id: 'sim-rear-front', startLat: 17.3849, startLng: 78.4870,
        heading: 0, speed: 5, distStart: 50, direction: 'north',
      },
      {
        id: 'sim-rear-back', startLat: 17.3840, startLng: 78.4870,
        heading: 0, speed: 12, distStart: 60, direction: 'north',
      },
    ],
  },

  // Scenario 3 — Wrong direction (head on)
  wrong_direction: {
    name: 'Wrong Direction (head on)',
    intersection: null,
    vehicles: [
      {
        id: 'sim-wd-1', startLat: 17.3849, startLng: 78.4870,
        heading: 0, speed: 10, distStart: 50, direction: 'north',
      },
      {
        id: 'sim-wd-2', startLat: 17.3858, startLng: 78.4870,
        heading: 180, speed: 10, distStart: 50, direction: 'south',
      },
    ],
  },

  // Scenario 4 — High speed turn (60 km/h ≈ 16.7 m/s)
  high_speed_turn: {
    name: 'High Speed Turn (60 km/h)',
    intersection: { lat: 17.3849, lng: 78.4870 },
    vehicles: [
      {
        id: 'sim-fast-1', startLat: 17.3835, startLng: 78.4870,
        heading: 0, speed: 16.7, distStart: 156, direction: 'north',
      },
      {
        id: 'sim-fast-2', startLat: 17.3849, startLng: 78.4855,
        heading: 90, speed: 16.7, distStart: 167, direction: 'east',
      },
    ],
  },
};

// Select scenario from command line arg, default to turn_collision
const scenarioName = process.argv[2] || 'turn_collision';
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`Unknown scenario: ${scenarioName}`);
  console.error(`Available: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const INTERSECTION = scenario.intersection;
const CONFIG = scenario.vehicles;

let ACCESS_TOKEN = null;

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      loginname: 'testuser',
      password: 'testpass123',
    });
    const options = {
      hostname: 'localhost',
      port: 5001,
      path: '/api/Login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.accessToken) {
            resolve(data.accessToken);
          } else {
            console.warn('⚠️ Login response has no token, using unauthenticated connection');
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => {
      console.warn('⚠️ Could not get auth token (server may not have auth yet), continuing without');
      resolve(null);
    });
    req.write(postData);
    req.end();
  });
}

const connections = [];
const startTime = Date.now();

function connectVehicle(cfg) {
  return new Promise((resolve) => {
    const wsUrl = ACCESS_TOKEN
      ? `${WS_BASE}?token=${ACCESS_TOKEN}`
      : WS_BASE;
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log(`✅ ${cfg.id} connected (${cfg.direction}, ${cfg.speed} m/s)`);
      resolve(ws);
    });
    ws.on('error', (e) => console.error(`❌ ${cfg.id} error:`, e.message));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.status === 'threat' || (msg.threats && msg.threats.length > 0)) {
        const threats = msg.threats || [msg.data].filter(Boolean);
        threats.forEach(t => {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`\n🚨 [${elapsed}s] COLLISION THREAT for ${cfg.id}:`);
          console.log(`   Type: ${t.type}`);
          console.log(`   Severity: ${t.severity || 1}`);
          console.log(`   Message: ${t.message}`);
          if (t.intersectionLat) console.log(`   Intersection: (${t.intersectionLat}, ${t.intersectionLng})`);
          console.log('');
        });
      }
    });
    ws.on('close', () => console.log(`🔌 ${cfg.id} disconnected`));
  });
}

async function run() {
  console.log(`\n=== SIMULATION: ${scenario.name} ===`);
  if (INTERSECTION) {
    console.log(`Intersection: (${INTERSECTION.lat}, ${INTERSECTION.lng})`);
  }
  CONFIG.forEach((cfg, i) => {
    console.log(`Vehicle ${i + 1}: heading ${cfg.heading}° at ${cfg.speed} m/s (${(cfg.speed * 3.6).toFixed(0)} km/h)`);
  });
  console.log('');

  // Get auth token
  ACCESS_TOKEN = await getAccessToken();
  if (ACCESS_TOKEN) {
    console.log('🔑 Got auth token for WebSocket connections\n');
  } else {
    console.log('⚠️ Connecting without auth token\n');
  }

  // Connect all vehicles
  for (const cfg of CONFIG) {
    const ws = await connectVehicle(cfg);
    connections.push({ ws, cfg });
  }

  // Send data every 1 second
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const elapsed = (Date.now() - startTime) / 1000;

    for (const { ws, cfg } of connections) {
      const distTraveled = cfg.speed * step;
      const distToTurn = INTERSECTION
        ? Math.max(0, cfg.distStart - distTraveled)
        : (cfg.distStart - distTraveled);

      const turnAhead = INTERSECTION
        ? (distToTurn <= 40 && distToTurn >= 2)
        : false;

      const fraction = Math.min(1, distTraveled / (cfg.distStart || 1));
      let lat, lng;

      if (cfg.direction === 'north') {
        lat = cfg.startLat + ((INTERSECTION?.lat ?? (cfg.startLat + 0.01)) - cfg.startLat) * fraction;
        lng = cfg.startLng;
      } else if (cfg.direction === 'south') {
        lat = cfg.startLat - (cfg.startLat - (INTERSECTION?.lat ?? (cfg.startLat - 0.01))) * fraction;
        lng = cfg.startLng;
      } else {
        lat = cfg.startLat;
        lng = cfg.startLng + ((INTERSECTION?.lng ?? (cfg.startLng + 0.01)) - cfg.startLng) * fraction;
      }

      const payload = {
        userId: cfg.id,
        latitude: lat,
        longitude: lng,
        speed: cfg.speed,
        heading: cfg.heading,
        gyro: { x: 0, y: 0, z: 0 },
        turnAhead: turnAhead,
        turnType: INTERSECTION ? 'left_turn' : undefined,
        turnDistance: INTERSECTION ? distToTurn : undefined,
        intersectionLat: INTERSECTION?.lat,
        intersectionLng: INTERSECTION?.lng,
        connectivity: 'wifi',
        timestamp: new Date().toISOString(),
      };

      ws.send(JSON.stringify(payload));

      const indicator = turnAhead ? '🔴 TURN' : '    ';
      console.log(`  [${elapsed.toFixed(1)}s] ${cfg.id}: ${Math.abs(distToTurn).toFixed(0)}m from turn ${indicator}`);
    }

    const maxSteps = Math.max(...CONFIG.map(c => Math.ceil(c.distStart / Math.max(c.speed, 0.1)) + 5));
    if (step > maxSteps) {
      clearInterval(timer);
      console.log('\n✅ Simulation complete');
      connections.forEach(c => c.ws.close());
      process.exit(0);
    }
  }, 1000);

  setTimeout(() => {
    console.log('\n⏱️ Timeout');
    connections.forEach(c => c.ws.close());
    process.exit(0);
  }, 60000);
}

run().catch(e => { console.error(e); process.exit(1); });
