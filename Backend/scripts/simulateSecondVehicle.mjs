import WebSocket from 'ws';

const WS_URL = 'ws://localhost:5001';
const USER_ID = 'test-vehicle-2';

// Use a known Hyderabad intersection from the road data
// Near Koti Women's College Road at (17.3849, 78.4870)
const INTERSECTION = { lat: 17.3849, lng: 78.4870 };

// Second vehicle starts 50m away coming from the east
const VEHICLE_START = { lat: 17.3849, lng: 78.4875 };

const ws = new WebSocket(WS_URL);
let step = 0;
let sendInterval = null;

ws.on('open', () => {
  console.log('✅ Simulated vehicle connected to WebSocket');
  console.log(`   Intersection: (${INTERSECTION.lat}, ${INTERSECTION.lng})`);
  console.log(`   Starting at:  (${VEHICLE_START.lat}, ${VEHICLE_START.lng})`);
  console.log('   Moving west toward intersection at 10 m/s');
  console.log('');

  // Send data every 1 second (same as real frontend)
  sendInterval = setInterval(() => {
    step++;
    const distToTurn = 50 - step * 10; // approach 10m per sec
    if (distToTurn <= 0) {
      clearInterval(sendInterval);
      console.log('🛑 Reached intersection. Stopping simulation.');
      ws.close();
      process.exit(0);
    }

    // Move toward intersection
    const fraction = (50 - distToTurn) / 50;
    const lat = VEHICLE_START.lat + (INTERSECTION.lat - VEHICLE_START.lat) * fraction;
    const lng = VEHICLE_START.lng + (INTERSECTION.lng - VEHICLE_START.lng) * fraction;

    const payload = {
      userId: USER_ID,
      latitude: lat,
      longitude: lng,
      speed: 10,        // 10 m/s (~36 km/h)
      heading: 270,     // heading west
      gyro: { x: 0, y: 0, z: 0 },
      turnAhead: distToTurn <= 40 && distToTurn >= 5, // turn detected 40-5m from intersection
      turnType: 'left_turn',
      turnDistance: distToTurn,
      intersectionLat: INTERSECTION.lat,
      intersectionLng: INTERSECTION.lng,
      connectivity: 'wifi',
      timestamp: new Date().toISOString(),
    };

    ws.send(JSON.stringify(payload));
    console.log(`🚗 Step ${step}: ${distToTurn.toFixed(0)}m from turn | turnAhead=${payload.turnAhead} | speed=${payload.speed} m/s`);
  }, 1000);
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.status === 'received' && msg.threats?.length > 0) {
    console.log('\n🚨🚨🚨 COLLISION THREAT DETECTED! 🚨🚨🚨');
    msg.threats.forEach(t => console.log(`   Type: ${t.type} | Message: ${t.message}`));
    console.log('');
  } else if (msg.status === 'threat') {
    console.log('\n🚨 RECEIVED DIRECT THREAT PUSH:');
    console.log(`   ${JSON.stringify(msg.data, null, 2)}`);
    console.log('');
  }
});

ws.on('close', () => {
  console.log('Connection closed');
  clearInterval(sendInterval);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  clearInterval(sendInterval);
  process.exit(1);
});

// Auto-stop after 15 seconds
setTimeout(() => {
  console.log('\n⏱️ Simulation complete');
  ws.close();
  process.exit(0);
}, 15000);
