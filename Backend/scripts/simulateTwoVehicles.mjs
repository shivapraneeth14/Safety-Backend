import WebSocket from 'ws';

const WS_URL = 'ws://localhost:5001';
const INTERSECTION = { lat: 17.3849, lng: 78.4870 };

// Vehicle 1: coming from south, heading north at 8 m/s
// Vehicle 2: coming from west, heading east at 8 m/s
const CONFIG = [
  {
    id: 'sim-vehicle-1',
    startLat: 17.3842,
    startLng: 78.4870,
    heading: 0,    // north
    speed: 8,      // 8 m/s ≈ 29 km/h
    distStart: 78, // 78m from intersection
    direction: 'north',
  },
  {
    id: 'sim-vehicle-2',
    startLat: 17.3849,
    startLng: 78.4862,
    heading: 90,   // east
    speed: 8,
    distStart: 90,
    direction: 'east',
  },
];

const connections = [];
const startTime = Date.now();

function connectVehicle(cfg) {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
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
  console.log('=== TWO-VEHICLE COLLISION SIMULATION ===');
  console.log(`Intersection: (${INTERSECTION.lat}, ${INTERSECTION.lng})`);
  console.log(`Vehicle 1: coming from SOUTH at 8 m/s`);
  console.log(`Vehicle 2: coming from WEST at 8 m/s`);
  console.log(`Both will reach intersection at ~ same time\n`);

  // Connect both vehicles
  for (const cfg of CONFIG) {
    const ws = await connectVehicle(cfg);
    connections.push({ ws, cfg });
  }

  // Send data for both vehicles every 1 second
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const elapsed = (Date.now() - startTime) / 1000;

    for (const { ws, cfg } of connections) {
      // Move vehicle toward intersection based on speed
      const distTraveled = cfg.speed * step; // meters traveled so far
      const distToTurn = Math.max(0, cfg.distStart - distTraveled);
      const turnAhead = distToTurn <= 40 && distToTurn >= 2;

      // Calculate current position (linear interpolation toward intersection)
      const fraction = Math.min(1, distTraveled / cfg.distStart);
      let lat, lng;
      if (cfg.direction === 'north') {
        lat = cfg.startLat + (INTERSECTION.lat - cfg.startLat) * fraction;
        lng = cfg.startLng;
      } else {
        lat = cfg.startLat;
        lng = cfg.startLng + (INTERSECTION.lng - cfg.startLng) * fraction;
      }

      const payload = {
        userId: cfg.id,
        latitude: lat,
        longitude: lng,
        speed: cfg.speed,
        heading: cfg.heading,
        gyro: { x: 0, y: 0, z: 0 },
        turnAhead: turnAhead,
        turnType: 'left_turn',
        turnDistance: distToTurn,
        intersectionLat: INTERSECTION.lat,
        intersectionLng: INTERSECTION.lng,
        connectivity: 'wifi',
        timestamp: new Date().toISOString(),
      };

      ws.send(JSON.stringify(payload));

      const indicator = turnAhead ? '🔴 TURN' : '    ';
      console.log(`  [${elapsed.toFixed(1)}s] ${cfg.id}: ${distToTurn.toFixed(0)}m from turn ${indicator}`);
    }

    // Stop when both reach the intersection
    if (step > CONFIG[0].distStart / CONFIG[0].speed + 2) {
      clearInterval(timer);
      console.log('\n✅ Simulation complete');
      connections.forEach(c => c.ws.close());
      process.exit(0);
    }
  }, 1000);

  // Safety timeout
  setTimeout(() => {
    console.log('\n⏱️ Timeout');
    connections.forEach(c => c.ws.close());
    process.exit(0);
  }, 30000);
}

run().catch(e => { console.error(e); process.exit(1); });
