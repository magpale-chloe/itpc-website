import test from 'node:test';
import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { PostgresDutyLogStore } from './duty-log-store.ts';

test('PostgreSQL store retains members and completed attendance across store instances', { concurrency: false }, async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const pg = database.adapters.createPg();
  const firstPool = new pg.Pool();
  const firstStore = new PostgresDutyLogStore('postgres://test:test@localhost/test', firstPool);
  const secondStore = new PostgresDutyLogStore('postgres://test:test@localhost/test', new pg.Pool());

  try {
    await firstStore.initialize();
    const member = await firstStore.createStudent({
      name: 'Database Member',
      rfid_uid: 'db-card-01',
      position: 'Secretary'
    });
    const officer = await firstStore.createStudent({
      name: 'Attendance Officer',
      rfid_uid: 'officer-card',
      position: 'President'
    });

    const clockIn = await firstStore.recordScan(member.rfid_uid, officer.id);
    assert.equal(clockIn.action, 'CLOCK_IN');
    assert.equal(clockIn.scannedByOfficerName, 'Attendance Officer');

    const clockOut = await firstStore.recordScan(member.rfid_uid, officer.id);
    assert.equal(clockOut.action, 'CLOCK_OUT');
    assert.equal(clockOut.clockInTime, clockIn.clockInTime);
    assert.ok(clockOut.clockOutTime);

    await secondStore.initialize();
    const [savedStudents, savedLogs] = await Promise.all([
      secondStore.listStudents(),
      secondStore.listRecentLogs()
    ]);
    assert.equal(savedStudents.length, 2);
    assert.equal(savedStudents[0].name, 'Attendance Officer');
    assert.equal(savedLogs.length, 1);
    assert.equal(savedLogs[0].studentName, 'Database Member');
    assert.equal(savedLogs[0].clockInTime, clockIn.clockInTime);
    assert.equal(savedLogs[0].clockOutTime, clockOut.clockOutTime);
    assert.equal(savedLogs[0].status, 'COMPLETED');

    const manualLog = await firstStore.createManualLog('Guest Volunteer', officer.id);
    assert.equal(manualLog.isNonMember, true);
    assert.equal(manualLog.rfidUid, '');
    assert.equal(manualLog.scannedByOfficerId, officer.id);
    assert.equal(manualLog.scannedByOfficerName, officer.name);
    const manualClockOut = await secondStore.clockOutLog(manualLog.id);
    assert.equal(manualClockOut.status, 'COMPLETED');
    assert.ok(manualClockOut.clockOutTime);
    await firstStore.deleteLog(manualLog.id);
    assert.deepEqual((await secondStore.listRecentLogs()).map((entry) => entry.studentName), ['Database Member']);
  } finally {
    await Promise.all([firstStore.close(), secondStore.close()]);
  }
});

test('PostgreSQL store saves member types and photos and lists logs by clock-in range', { concurrency: false }, async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const pg = database.adapters.createPg();
  const store = new PostgresDutyLogStore('postgres://test:test@localhost/test', new pg.Pool());

  try {
    await store.initialize();
    const committee = await store.createStudent({
      name: 'Committee Member',
      rfid_uid: 'com-card',
      position: 'Logistics',
      member_type: 'COMMITTEE',
      photo_url: 'data:image/jpeg;base64,AAAA'
    });
    const officer = await store.createStudent({ name: 'Officer', rfid_uid: 'off-card', position: 'President' });
    assert.equal(officer.member_type, 'OFFICER');
    assert.equal(officer.photo_url, '');

    const renamed = await store.updateStudent(committee.id, { name: 'Renamed', rfid_uid: 'com-card', position: 'Logistics' });
    assert.equal(renamed.member_type, 'COMMITTEE');
    assert.equal(renamed.photo_url, 'data:image/jpeg;base64,AAAA');

    await assert.rejects(store.recordScan('off-card', committee.id), { status: 403 });
    await store.recordScan('com-card', officer.id);

    const now = Date.now();
    const inRange = await store.listLogsBetween(new Date(now - 60_000), new Date(now + 60_000));
    assert.deepEqual(inRange.map((entry) => entry.studentName), ['Renamed']);
    assert.deepEqual(await store.listLogsBetween(new Date(now + 60_000), new Date(now + 120_000)), []);
  } finally {
    await store.close();
  }
});

test('PostgreSQL store edits duty log times and recalculates hours', { concurrency: false }, async () => {
  const database = newDb({ noAstCoverageCheck: true });
  const pg = database.adapters.createPg();
  const store = new PostgresDutyLogStore('postgres://test:test@localhost/test', new pg.Pool());

  try {
    await store.initialize();
    const member = await store.createStudent({ name: 'Edited Member', rfid_uid: 'edit-card', position: '' });
    const active = await store.recordScan(member.rfid_uid);

    const clockIn = new Date('2026-01-05T08:00:00.000Z');
    const stillActive = await store.updateLogTimes(active.id, clockIn, null);
    assert.equal(stillActive.status, 'ACTIVE');
    assert.equal(stillActive.clockInTime, clockIn.toISOString());

    const completed = await store.updateLogTimes(active.id, clockIn, new Date('2026-01-05T10:30:00.000Z'));
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.totalDutyHours, 2.5);

    await assert.rejects(store.updateLogTimes(active.id, clockIn, null), { status: 400 });
    await assert.rejects(store.updateLogTimes('missing', clockIn, null), { status: 404 });
  } finally {
    await store.close();
  }
});
