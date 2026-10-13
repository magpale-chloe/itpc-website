import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './server.ts';

async function postDutyLog(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = createApp();
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/duty-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return { status: response.status, data };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postDutyLogOnApp(app: ReturnType<typeof createApp>, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/duty-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    return { status: response.status, data };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('clock in for a registered student', { concurrency: false }, async () => {
  const result = await postDutyLog({ tag_id: 'abc123' }, {
    Authorization: `Basic ${Buffer.from('officer-101:secret').toString('base64')}`
  });

  assert.equal(result.status, 200);
  assert.equal(result.data.action, 'CLOCK_IN');
  assert.equal(result.data.studentName, 'Alice Santos');
  assert.equal(result.data.scannedByOfficerId, 'officer-101');
  assert.equal(result.data.scannedByOfficerName, 'officer-101');
  assert.ok(result.data.timestamp);
});

test('rejects Committee / JO login as Executive Board-only access', { concurrency: false }, async () => {
  const app = createApp();
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'committee',
        password: 'secret',
        role: 'committee'
      })
    });
    const result = await response.json();
    assert.equal(response.status, 400);
    assert.equal(result.error, 'Username, password, and account type are required');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('clock out for an active duty log', { concurrency: false }, async () => {
  const app = createApp();
  const first = await postDutyLogOnApp(app, { identifier: 'abc123' }, {
    Authorization: `Basic ${Buffer.from('officer-101:secret').toString('base64')}`
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.action, 'CLOCK_IN');

  const second = await postDutyLogOnApp(app, { tag_id: 'abc123' }, {
    Authorization: `Basic ${Buffer.from('officer-202:secret').toString('base64')}`
  });
  assert.equal(second.status, 200);
  assert.equal(second.data.action, 'CLOCK_OUT');
  assert.equal(second.data.studentName, 'Alice Santos');
  assert.equal(second.data.clockInTime, first.data.clockInTime);
  assert.ok(second.data.clockOutTime);
  assert.equal(second.data.status, 'COMPLETED');
  assert.equal(second.data.scannedByOfficerId, 'officer-101');
  assert.equal(second.data.scannedByOfficerName, 'officer-101');
  assert.equal(second.data.scannedByClockOutOfficerId, 'officer-202');
  assert.equal(second.data.scannedByClockOutOfficerName, 'officer-202');
  assert.equal(typeof second.data.totalDutyHours, 'number');
});

test('updates the member linked to an RFID card and returns complete scan spans', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [{ username: 'exec', password: 'secret', role: 'executive' }]
  });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200);

    const rosterResponse = await fetch(`${baseUrl}/api/students`);
    const roster = await rosterResponse.json();
    assert.equal(roster[0].rfid_uid, 'abc123');

    const updateResponse = await fetch(`${baseUrl}/api/students/student-1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: ['Bearer', login.token].join(' ')
      },
      body: JSON.stringify({ name: 'Updated Member', rfid_uid: 'new-card', position: 'President' })
    });
    const updated = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updated.name, 'Updated Member');
    assert.equal(updated.rfid_uid, 'new-card');
    assert.equal(updated.position, 'President');

    const firstScan = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'new-card' })
    });
    const clockIn = await firstScan.json();
    assert.equal(firstScan.status, 200);
    assert.equal(clockIn.studentName, 'Updated Member');
    assert.equal(clockIn.position, 'President');
    assert.equal(clockIn.rfidUid, 'new-card');
    assert.ok(clockIn.clockInTime);
    assert.equal(clockIn.status, 'ACTIVE');

    const secondScan = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'new-card' })
    });
    const clockOut = await secondScan.json();
    assert.equal(secondScan.status, 200);
    assert.equal(clockOut.action, 'CLOCK_OUT');
    assert.equal(clockOut.clockInTime, clockIn.clockInTime);
    assert.ok(clockOut.clockOutTime);
    assert.equal(clockOut.status, 'COMPLETED');
    assert.equal(typeof clockOut.totalDutyHours, 'number');

    const duplicateResponse = await fetch(`${baseUrl}/api/students/student-1`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${login.token}`
      },
      body: JSON.stringify({ name: 'Updated Member', rfid_uid: 'def456', position: 'President' })
    });
    assert.equal(duplicateResponse.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('registers a new RFID card for an executive and accepts its scan', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [{ username: 'exec', password: 'secret', role: 'executive' }]
  });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    });
    const login = await loginResponse.json();
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${login.token}`
    };
    const createResponse = await fetch(`${baseUrl}/api/students`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Chloe Member', rfid_uid: 'uid-987', position: 'Treasurer' })
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.equal(created.name, 'Chloe Member');
    assert.equal(created.rfid_uid, 'uid-987');
    assert.equal(created.position, 'Treasurer');

    const scanResponse = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'uid-987' })
    });
    const scan = await scanResponse.json();
    assert.equal(scanResponse.status, 200);
    assert.equal(scan.studentName, 'Chloe Member');
    assert.equal(scan.position, 'Treasurer');

    const duplicateResponse = await fetch(`${baseUrl}/api/students`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Another Member', rfid_uid: 'UID-987', position: 'Secretary' })
    });
    assert.equal(duplicateResponse.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('records the selected officer and only deletes roster members after active duty is complete', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [{ username: 'exec', password: 'secret', role: 'executive' }]
  });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    });
    const login = await loginResponse.json();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', String(login.token)].join(' ')
    };

    const clockInResponse = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'abc123', officerId: 'student-2' })
    });
    const clockIn = await clockInResponse.json();
    assert.equal(clockIn.scannedByOfficerId, 'student-2');
    assert.equal(clockIn.scannedByOfficerName, 'Brian Cruz');

    const deleteWhileActive = await fetch(`${baseUrl}/api/students/student-1`, {
      method: 'DELETE',
      headers
    });
    assert.equal(deleteWhileActive.status, 409);

    const clockOutResponse = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'abc123', officerId: 'student-2' })
    });
    const clockOut = await clockOutResponse.json();
    assert.equal(clockOut.scannedByClockOutOfficerId, 'student-2');
    assert.equal(clockOut.scannedByClockOutOfficerName, 'Brian Cruz');

    const deleteResponse = await fetch(`${baseUrl}/api/students/student-1`, {
      method: 'DELETE',
      headers
    });
    assert.equal(deleteResponse.status, 204);

    const remainingStudents = await fetch(`${baseUrl}/api/students`);
    const roster = await remainingStudents.json();
    assert.deepEqual(roster.map((student: { id: string }) => student.id), ['student-2']);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('allows authenticated browser DELETE requests through CORS preflight', { concurrency: false }, async () => {
  const app = createApp();
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/students/student-1`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:4200',
        'Access-Control-Request-Method': 'DELETE',
        'Access-Control-Request-Headers': 'authorization'
      }
    });

    assert.equal(response.status, 204);
    assert.match(response.headers.get('access-control-allow-methods') ?? '', /DELETE/);
    assert.match(response.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('allows Executive Board to add name-only logs, manually clock out, and delete duty logs', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [{ username: 'exec', password: 'secret', role: 'executive' }]
  });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${baseUrl}/api/duty-log/manual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Visitor' })
    });
    assert.equal(unauthorized.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    });
    const login = await loginResponse.json();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + String(login.token)
    };

    const missingOfficerResponse = await fetch(`${baseUrl}/api/duty-log/manual`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Guest Volunteer' })
    });
    assert.equal(missingOfficerResponse.status, 400);

    const manualResponse = await fetch(`${baseUrl}/api/duty-log/manual`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '  Guest Volunteer  ', officerId: 'student-2' })
    });
    const manualLog = await manualResponse.json();
    assert.equal(manualResponse.status, 201);
    assert.equal(manualLog.studentName, 'Guest Volunteer');
    assert.equal(manualLog.isNonMember, true);
    assert.equal(manualLog.rfidUid, '');
    assert.equal(manualLog.position, '');
    assert.equal(manualLog.status, 'ACTIVE');
    assert.equal(manualLog.scannedByOfficerId, 'student-2');
    assert.equal(manualLog.scannedByOfficerName, 'Brian Cruz');

    const clockOutResponse = await fetch(`${baseUrl}/api/duty-log/${manualLog.id}/clock-out`, {
      method: 'PATCH',
      headers
    });
    const completedLog = await clockOutResponse.json();
    assert.equal(clockOutResponse.status, 200);
    assert.equal(completedLog.status, 'COMPLETED');
    assert.ok(completedLog.clockOutTime);

    const repeatedClockOut = await fetch(`${baseUrl}/api/duty-log/${manualLog.id}/clock-out`, {
      method: 'PATCH',
      headers
    });
    assert.equal(repeatedClockOut.status, 409);

    const deleteResponse = await fetch(`${baseUrl}/api/duty-log/${manualLog.id}`, {
      method: 'DELETE',
      headers
    });
    assert.equal(deleteResponse.status, 204);

    const deletedClockOut = await fetch(`${baseUrl}/api/duty-log/${manualLog.id}/clock-out`, {
      method: 'PATCH',
      headers
    });
    assert.equal(deletedClockOut.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('captures the officer who performed each scan and exposes recent logs', { concurrency: false }, async () => {
  const app = createApp();
  const clockInHeader = {
    Authorization: `Basic ${Buffer.from('officer-101:secret').toString('base64')}`
  };
  const clockOutHeader = {
    Authorization: `Basic ${Buffer.from('officer-202:secret').toString('base64')}`
  };

  const first = await postDutyLogOnApp(app, { identifier: 'abc123' }, clockInHeader);
  assert.equal(first.status, 200);
  assert.equal(first.data.scannedByOfficerId, 'officer-101');
  assert.equal(first.data.scannedByOfficerName, 'officer-101');

  const second = await postDutyLogOnApp(app, { tag_id: 'abc123' }, clockOutHeader);
  assert.equal(second.status, 200);
  assert.equal(second.data.scannedByOfficerId, 'officer-101');
  assert.equal(second.data.scannedByOfficerName, 'officer-101');
  assert.equal(second.data.scannedByClockOutOfficerId, 'officer-202');
  assert.equal(second.data.scannedByClockOutOfficerName, 'officer-202');

  const server = app.listen(0);
  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/duty-log/recent`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(data));
    assert.equal(data[0].studentName, 'Alice Santos');
    assert.equal(data[0].scannedByOfficerName, 'officer-101');
    assert.equal(data[0].scannedByClockOutOfficerName, 'officer-202');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('returns 404 when the card is not registered', { concurrency: false }, async () => {
  const result = await postDutyLog({ identifier: 'unknown-card' });

  assert.equal(result.status, 404);
  assert.deepEqual(result.data, { error: 'Card not registered' });
});
