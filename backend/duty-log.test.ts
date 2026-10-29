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

test('rejects Committee login when no Committee account is configured', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [
      { username: 'exec', password: 'secret', role: 'executive' },
      { username: '', password: '', role: 'committee' }
    ]
  });
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
    assert.equal(response.status, 401);
    assert.equal(result.error, 'Invalid account type or credentials');
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

test('stores member types and photos, and only lets Officers and Junior Officers clock entries', { concurrency: false }, async () => {
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
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    })).json();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: ['Bearer', String(login.token)].join(' ')
    };
    const photo = 'data:image/jpeg;base64,AAAA';

    const createMember = (body: Record<string, unknown>) => fetch(`${baseUrl}/api/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const invalidType = await createMember({ name: 'X', rfid_uid: 'x-1', position: '', member_type: 'GUEST' });
    assert.equal(invalidType.status, 400);
    const invalidPhoto = await createMember({ name: 'X', rfid_uid: 'x-1', position: '', photo_url: 'https://example.com/a.png' });
    assert.equal(invalidPhoto.status, 400);
    const unknownCommittee = await createMember({ name: 'X', rfid_uid: 'x-1', position: 'Catering', member_type: 'COMMITTEE' });
    assert.equal(unknownCommittee.status, 400);

    const committee = await (await createMember({
      name: 'Committee Member', rfid_uid: 'com-1', position: 'Logistics', member_type: 'COMMITTEE', photo_url: photo
    })).json();
    assert.equal(committee.member_type, 'COMMITTEE');
    assert.equal(committee.photo_url, photo);
    const juniorOfficer = await (await createMember({
      name: 'Junior Officer', rfid_uid: 'jo-1', position: 'JO', member_type: 'JUNIOR_OFFICER'
    })).json();
    assert.equal(juniorOfficer.photo_url, '');

    // Editing without member_type/photo_url keeps the stored values.
    const edited = await (await fetch(`${baseUrl}/api/students/${committee.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Committee Renamed', rfid_uid: 'com-1', position: 'Logistics' })
    })).json();
    assert.equal(edited.member_type, 'COMMITTEE');
    assert.equal(edited.photo_url, photo);

    const committeeClocking = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'abc123', officerId: committee.id })
    });
    assert.equal(committeeClocking.status, 403);
    const committeeManual = await fetch(`${baseUrl}/api/duty-log/manual`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Guest', officerId: committee.id })
    });
    assert.equal(committeeManual.status, 403);

    const joClocking = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'com-1', officerId: juniorOfficer.id })
    });
    assert.equal(joClocking.status, 200);
    assert.equal((await joClocking.json()).scannedByOfficerName, 'Junior Officer');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('lists duty logs in a date range and keeps active logs first in recent logs', { concurrency: false }, async () => {
  const app = createApp();
  await postDutyLogOnApp(app, { identifier: 'abc123', officerId: 'student-2' });
  await postDutyLogOnApp(app, { identifier: 'abc123', officerId: 'student-2' });
  await postDutyLogOnApp(app, { identifier: 'def456', officerId: 'student-2' });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const recent = await (await fetch(`${baseUrl}/api/duty-log/recent`)).json();
    assert.deepEqual(recent.map((entry: { status: string }) => entry.status), ['ACTIVE', 'COMPLETED']);
    assert.equal(recent[0].studentName, 'Brian Cruz');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const inRange = await fetch(`${baseUrl}/api/duty-log?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    assert.equal(inRange.status, 200);
    assert.equal((await inRange.json()).length, 2);

    const past = await (await fetch(`${baseUrl}/api/duty-log?from=2020-01-01T00:00:00Z&to=2020-01-08T00:00:00Z`)).json();
    assert.deepEqual(past, []);

    const invalid = await fetch(`${baseUrl}/api/duty-log?from=nope&to=${encodeURIComponent(to)}`);
    assert.equal(invalid.status, 400);
    const tooLong = await fetch(`${baseUrl}/api/duty-log?from=2020-01-01T00:00:00Z&to=2021-01-01T00:00:00Z`);
    assert.equal(tooLong.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('keeps Executive Board sessions valid across a server restart until logout', { concurrency: false }, async () => {
  const credentials = [{ username: 'exec', password: 'secret', role: 'executive' as const }];
  const withServer = async <T>(app: ReturnType<typeof createApp>, run: (baseUrl: string) => Promise<T>) => {
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Server did not bind to a local port');
      }
      return await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
  const me = (baseUrl: string, token: string) =>
    fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: ['Bearer', token].join(' ') } });

  const token = await withServer(createApp({ credentials }), async (baseUrl) => {
    const login = await (await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'exec', password: 'secret', role: 'executive' })
    })).json();
    return String(login.token);
  });

  const restarted = createApp({ credentials });
  await withServer(restarted, async (baseUrl) => {
    assert.equal((await me(baseUrl, token)).status, 200);
    assert.equal((await me(baseUrl, token.slice(0, -2) + 'xx')).status, 401);
    await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: ['Bearer', token].join(' ') }
    });
    assert.equal((await me(baseUrl, token)).status, 401);
  });

  const passwordChanged = createApp({ credentials: [{ ...credentials[0], password: 'rotated' }] });
  await withServer(passwordChanged, async (baseUrl) => {
    assert.equal((await me(baseUrl, token)).status, 401);
  });
});

test('lets the Executive Board edit duty log times and recalculates hours', { concurrency: false }, async () => {
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
    const scan = await fetch(`${baseUrl}/api/duty-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'abc123' })
    });
    const log = await scan.json();
    const editUrl = `${baseUrl}/api/duty-log/${log.id}`;
    const body = (clockInTime: string, clockOutTime?: string | null) => JSON.stringify({ clockInTime, clockOutTime });

    const unauthorized = await fetch(editUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body('2026-01-05T08:00:00.000Z')
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

    const invalid = await fetch(editUrl, { method: 'PATCH', headers, body: body('not a date') });
    assert.equal(invalid.status, 400);
    const backwards = await fetch(editUrl, {
      method: 'PATCH',
      headers,
      body: body('2026-01-05T10:00:00.000Z', '2026-01-05T09:00:00.000Z')
    });
    assert.equal(backwards.status, 400);
    const future = await fetch(editUrl, {
      method: 'PATCH',
      headers,
      body: body(new Date(Date.now() + 3_600_000).toISOString())
    });
    assert.equal(future.status, 400);

    const completedResponse = await fetch(editUrl, {
      method: 'PATCH',
      headers,
      body: body('2026-01-05T08:00:00.000Z', '2026-01-05T09:45:00.000Z')
    });
    const completed = await completedResponse.json();
    assert.equal(completedResponse.status, 200);
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.clockInTime, '2026-01-05T08:00:00.000Z');
    assert.equal(completed.clockOutTime, '2026-01-05T09:45:00.000Z');
    assert.equal(completed.totalDutyHours, 1.75);

    const reopen = await fetch(editUrl, { method: 'PATCH', headers, body: body('2026-01-05T08:00:00.000Z', null) });
    assert.equal(reopen.status, 400);

    const missing = await fetch(`${baseUrl}/api/duty-log/missing`, {
      method: 'PATCH',
      headers,
      body: body('2026-01-05T08:00:00.000Z')
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('lets the Executive Board add past duty sessions without overlapping existing ones', { concurrency: false }, async () => {
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
    const addUrl = `${baseUrl}/api/duty-log/completed`;
    const body = (studentId: string, clockInTime: string, clockOutTime?: string) =>
      JSON.stringify({ studentId, clockInTime, clockOutTime });

    const unauthorized = await fetch(addUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body('student-1', '2026-01-05T08:00:00.000Z', '2026-01-05T09:00:00.000Z')
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

    const missingClockOut = await fetch(addUrl, { method: 'POST', headers, body: body('student-1', '2026-01-05T08:00:00.000Z') });
    assert.equal(missingClockOut.status, 400);
    const unknownMember = await fetch(addUrl, {
      method: 'POST',
      headers,
      body: body('missing', '2026-01-05T08:00:00.000Z', '2026-01-05T09:00:00.000Z')
    });
    assert.equal(unknownMember.status, 404);

    const addedResponse = await fetch(addUrl, {
      method: 'POST',
      headers,
      body: body('student-1', '2026-01-05T08:00:00.000Z', '2026-01-05T11:00:00.000Z')
    });
    const added = await addedResponse.json();
    assert.equal(addedResponse.status, 201);
    assert.equal(added.studentName, 'Alice Santos');
    assert.equal(added.status, 'COMPLETED');
    assert.equal(added.totalDutyHours, 3);

    const overlapping = await fetch(addUrl, {
      method: 'POST',
      headers,
      body: body('student-1', '2026-01-05T10:00:00.000Z', '2026-01-05T12:00:00.000Z')
    });
    assert.equal(overlapping.status, 409);
    const adjacent = await fetch(addUrl, {
      method: 'POST',
      headers,
      body: body('student-1', '2026-01-05T11:00:00.000Z', '2026-01-05T12:00:00.000Z')
    });
    assert.equal(adjacent.status, 201);

    const listed = await fetch(`${baseUrl}/api/duty-log?from=2026-01-05T00:00:00.000Z&to=2026-01-06T00:00:00.000Z`);
    assert.deepEqual((await listed.json()).map((entry: { totalDutyHours: number }) => entry.totalDutyHours), [3, 1]);

    const editIntoOverlap = await fetch(`${baseUrl}/api/duty-log/${added.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ clockInTime: '2026-01-05T08:00:00.000Z', clockOutTime: '2026-01-05T11:30:00.000Z' })
    });
    assert.equal(editIntoOverlap.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('lets Committee accounts view duty logs but refuses every edit', { concurrency: false }, async () => {
  const app = createApp({
    credentials: [
      { username: 'exec', password: 'secret', role: 'executive' },
      { username: 'committee', password: 'viewer', role: 'committee' }
    ]
  });
  const server = app.listen(0);

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Server did not bind to a local port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const wrongType = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'committee', password: 'viewer', role: 'executive' })
    });
    assert.equal(wrongType.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'committee', password: 'viewer', role: 'committee' })
    });
    const login = await loginResponse.json();
    assert.equal(loginResponse.status, 200);
    assert.equal(login.user.role, 'committee');

    const headers = { 'Content-Type': 'application/json', Authorization: ['Bearer', login.token].join(' ') };
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers });
    assert.equal(me.status, 200);

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const logs = await fetch(`${baseUrl}/api/duty-log?from=${from.toISOString()}&to=${to.toISOString()}`, { headers });
    assert.equal(logs.status, 200);

    const clockIn = new Date(to.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const clockOut = new Date(to.getTime() - 60 * 60 * 1000).toISOString();
    const writes: [string, string, unknown][] = [
      ['POST', '/api/students', { name: 'New', rfid_uid: 'card-x', position: 'Member' }],
      ['PATCH', '/api/students/student-1', { name: 'Changed', rfid_uid: 'abc123', position: 'President' }],
      ['DELETE', '/api/students/student-1', undefined],
      ['POST', '/api/duty-log/manual', { name: 'Guest', officerId: 'student-1' }],
      ['POST', '/api/duty-log/completed', { studentId: 'student-1', clockInTime: clockIn, clockOutTime: clockOut }],
      ['PATCH', '/api/duty-log/any-log', { clockInTime: clockIn, clockOutTime: clockOut }],
      ['PATCH', '/api/duty-log/any-log/clock-out', {}],
      ['DELETE', '/api/duty-log/any-log', undefined]
    ];
    for (const [method, path, body] of writes) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      assert.equal(response.status, 403, `${method} ${path} should be refused`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
