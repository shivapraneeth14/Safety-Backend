import WebSocket from 'ws';

const WS_URL = 'ws://localhost:5001';
const USER1 = { id: '6a1886d451d3691cfb12daee', token: '' };
const USER2 = { id: '6a1886d451d3691cfb12daf1', token: '' };

// Get tokens from login
async function getToken(loginname, password) {
  const http = await import('http');
  return new Promise((resolve) => {
    const postData = JSON.stringify({ loginname, password });
    const req = http.request({
      hostname: 'localhost', port: 5001, path: '/api/Login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(JSON.parse(body).accessToken));
    });
    req.write(postData);
    req.end();
  });
}

function connectVehicle(token, userId) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    ws.on('open', () => resolve(ws));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.threats?.length > 0 || msg.status === 'threat') {
        const threats = msg.threats || [msg.data];
        threats.forEach(t => console.log(`  🚨 ${userId} received: ${t.type} - ${t.message}`));
      }
    });
    ws.on('error', () => {});
  });
}

function sendLocation(ws, userId, lat, lng, speed, heading, turnAhead, turnLat, turnLng) {
  ws.send(JSON.stringify({
    userId, latitude: lat, longitude: lng, speed, heading,
    gyro: { x: 0, y: 0, z: 0 },
    turnAhead, turnType: turnAhead ? 't_junction' : undefined,
    turnDistance: turnAhead ? 30 : undefined,
    intersectionLat: turnLat, intersectionLng: turnLng,
    connectivity: 'wifi', timestamp: new Date().toISOString(),
  }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function testPredictedCollision() {
  console.log('\n=== 3.1 PREDICTED COLLISION TEST ===');
  USER1.token = await getToken('sim1', 'sim123');
  USER2.token = await getToken('sim2', 'sim123');
  console.log('Tokens obtained');

  const ws1 = await connectVehicle(USER1.token, USER1.id);
  const ws2 = await connectVehicle(USER2.token, USER2.id);
  console.log('Both connected');

  // Two vehicles approaching same point from opposite directions
  console.log('Sending: Vehicle 1 heading South (180°) at 8 m/s');
  console.log('Sending: Vehicle 2 heading North (0°) at 8 m/s');
  sendLocation(ws1, USER1.id, 17.3860, 78.4870, 8, 180, false);
  sendLocation(ws2, USER2.id, 17.3840, 78.4870, 8, 0, false);
  await sleep(1000);

  // Move them closer each second
  for (let step = 1; step <= 8; step++) {
    const lat1 = 17.3860 - (step * 0.0003);
    const lat2 = 17.3840 + (step * 0.0003);
    console.log(`Step ${step}: V1 at ${lat1.toFixed(5)}, V2 at ${lat2.toFixed(5)} (dist ~${((lat1 - lat2) * 111320).toFixed(0)}m)`);
    sendLocation(ws1, USER1.id, lat1, 78.4870, 8, 180, false);
    sendLocation(ws2, USER2.id, lat2, 78.4870, 8, 0, false);
    await sleep(1000);
  }

  ws1.close();
  ws2.close();
}

async function testTurnCollision() {
  console.log('\n=== 3.2 TURN COLLISION TEST ===');
  USER1.token = await getToken('sim1', 'sim123');
  USER2.token = await getToken('sim2', 'sim123');

  const ws1 = await connectVehicle(USER1.token, USER1.id);
  const ws2 = await connectVehicle(USER2.token, USER2.id);
  console.log('Both connected');

  // Both approaching same intersection from perpendicular directions
  const intLat = 17.3849, intLng = 78.4870;
  console.log(`Intersection: (${intLat}, ${intLng})`);

  for (let step = 0; step <= 10; step++) {
    // V1 from south going north, V2 from west going east
    const lat1 = 17.3842 + (step * 0.00007);
    const lng2 = 78.4862 + (step * 0.00008);
    const dist1 = 78 - (step * 7.8);
    const turn1 = dist1 <= 40 && dist1 >= 2;

    sendLocation(ws1, USER1.id, lat1, intLng, 8, 0, turn1, turn1 ? intLat : null, turn1 ? intLng : null);
    sendLocation(ws2, USER2.id, intLat, lng2, 8, 90, turn1, turn1 ? intLat : null, turn1 ? intLng : null);
    console.log(`Step ${step}: V1 dist=${Math.max(0,dist1).toFixed(0)}m ${turn1 ? '🔴 TURN ON' : ''} | V2 dist=${Math.max(0,dist1).toFixed(0)}m ${turn1 ? '🔴 TURN ON' : ''}`);
    await sleep(1000);
  }

  ws1.close();
  ws2.close();
}

async function testRearEnd() {
  console.log('\n=== 3.3 REAR-END TEST ===');
  USER1.token = await getToken('sim1', 'sim123');
  USER2.token = await getToken('sim2', 'sim123');

  const ws1 = await connectVehicle(USER1.token, USER1.id);
  const ws2 = await connectVehicle(USER2.token, USER2.id);
  console.log('Both connected');

  // V1 (front) at 5 m/s, V2 (rear) at 12 m/s closing fast
  // V1 decelerates suddenly
  console.log('Front vehicle (V1) at 5 m/s, rear vehicle (V2) at 12 m/s');

  for (let step = 0; step <= 12; step++) {
    const latBase = 17.3850;
    const speed1 = step < 4 ? 5 : (step < 6 ? 2 : 1); // V1 decelerates
    const speed2 = step < 8 ? 12 : 8;
    const lat1 = latBase - (step * 0.00015);
    const lat2 = lat1 + 0.0010 - (step * 0.00002); // V2 behind V1
    const dist = (lat2 - lat1) * 111320;

    sendLocation(ws1, USER1.id, lat1, 78.4870, speed1, 0, false);
    sendLocation(ws2, USER2.id, lat2, 78.4870, speed2, 0, false);
    console.log(`Step ${step}: V1 speed=${speed1}m/s V2 speed=${speed2}m/s dist=${dist.toFixed(1)}m`);
    await sleep(1000);
  }

  ws1.close();
  ws2.close();
}

// Run all tests sequentially
async function main() {
  await testPredictedCollision().catch(e => console.error('Predicted col error:', e.message));
  await new Promise(r => setTimeout(r, 2000));
  await testTurnCollision().catch(e => console.error('Turn col error:', e.message));
  await new Promise(r => setTimeout(r, 2000));
  await testRearEnd().catch(e => console.error('Rear-end error:', e.message));
  console.log('\n✅ All tests complete');
  process.exit(0);
}

main();
