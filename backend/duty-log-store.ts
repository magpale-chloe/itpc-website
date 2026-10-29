import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

export type DutyLogStatus = 'ACTIVE' | 'COMPLETED';
export type MemberType = 'OFFICER' | 'JUNIOR_OFFICER' | 'COMMITTEE';

export const MEMBER_TYPES: readonly MemberType[] = ['OFFICER', 'JUNIOR_OFFICER', 'COMMITTEE'];
// A Committee member's position is the committee they belong to.
export const COMMITTEE_POSITIONS: readonly string[] = ['Logistics', 'Data Management', 'Creatives', 'Technical & Documentation'];

export interface Student {
  id: string;
  name: string;
  rfid_uid: string;
  position: string;
  member_type: MemberType;
  photo_url: string;
}

// member_type and photo_url are optional on input: omitted values default on create and are kept on update.
export type StudentInput = Omit<Student, 'id' | 'member_type' | 'photo_url'> &
  Partial<Pick<Student, 'member_type' | 'photo_url'>>;

export interface DutyLog {
  id: string;
  studentId: string;
  studentName: string;
  rfidUid: string;
  position: string;
  isNonMember?: boolean;
  clockInTime: string;
  clockOutTime?: string;
  status: DutyLogStatus;
  totalDutyHours?: number;
  scannedByOfficerId?: string;
  scannedByOfficerName?: string;
  scannedByClockOutOfficerId?: string;
  scannedByClockOutOfficerName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficerIdentity {
  id: string;
  name: string;
}

export interface DutyScanResult extends DutyLog {
  action: 'CLOCK_IN' | 'CLOCK_OUT';
  timestamp: string;
}

export class StoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface DutyLogStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listStudents(): Promise<Student[]>;
  createStudent(input: StudentInput): Promise<Student>;
  updateStudent(id: string, input: StudentInput): Promise<Student>;
  deleteStudent(id: string): Promise<void>;
  recordScan(identifier: string, officerId?: string, fallbackOfficer?: OfficerIdentity | null): Promise<DutyScanResult>;
  createManualLog(name: string, officerId: string): Promise<DutyScanResult>;
  clockOutLog(id: string): Promise<DutyScanResult>;
  updateLogTimes(id: string, clockInTime: Date, clockOutTime: Date | null): Promise<DutyLog>;
  createCompletedLog(studentId: string, clockInTime: Date, clockOutTime: Date): Promise<DutyLog>;
  deleteLog(id: string): Promise<void>;
  listRecentLogs(): Promise<DutyLog[]>;
  listLogsBetween(from: Date, to: Date): Promise<DutyLog[]>;
}

type StudentRow = {
  id: string;
  name: string;
  rfid_uid: string;
  position: string;
  member_type: MemberType;
  photo_url: string;
};

const STUDENT_COLUMNS = 'id, name, rfid_uid, position, member_type, photo_url';
const RECENT_COMPLETED_LIMIT = 50;

type DutyLogRow = {
  id: string;
  student_id: string;
  student_name: string;
  rfid_uid: string;
  position: string;
  is_non_member: boolean;
  clock_in_time: Date | string;
  clock_out_time: Date | string | null;
  status: DutyLogStatus;
  total_duty_hours: string | number | null;
  scanned_by_officer_id: string | null;
  scanned_by_officer_name: string | null;
  scanned_by_clock_out_officer_id: string | null;
  scanned_by_clock_out_officer_name: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const schema = [
  `CREATE TABLE IF NOT EXISTS students (
    id text PRIMARY KEY,
    name text NOT NULL,
    rfid_uid text NOT NULL,
    position text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS students_rfid_uid_lower_unique
    ON students (lower(rfid_uid))`,
  `CREATE TABLE IF NOT EXISTS duty_logs (
    id text PRIMARY KEY,
    student_id text NOT NULL,
    student_name text NOT NULL,
    rfid_uid text NOT NULL,
    position text NOT NULL DEFAULT '',
    is_non_member boolean NOT NULL DEFAULT false,
    clock_in_time timestamptz NOT NULL,
    clock_out_time timestamptz,
    status text NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED')),
    total_duty_hours numeric(10, 2),
    scanned_by_officer_id text,
    scanned_by_officer_name text,
    scanned_by_clock_out_officer_id text,
    scanned_by_clock_out_officer_name text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS duty_logs_one_active_per_student
    ON duty_logs (student_id) WHERE status = 'ACTIVE'`,
  `ALTER TABLE duty_logs ADD COLUMN IF NOT EXISTS is_non_member boolean NOT NULL DEFAULT false`,
  `CREATE INDEX IF NOT EXISTS duty_logs_updated_at_desc ON duty_logs (updated_at DESC)`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS member_type text NOT NULL DEFAULT 'OFFICER'`,
  `ALTER TABLE students ADD COLUMN IF NOT EXISTS photo_url text NOT NULL DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS duty_logs_clock_in_time ON duty_logs (clock_in_time)`
];

export class PostgresDutyLogStore implements DutyLogStore {
  private readonly pool: Pool;

  constructor(connectionString: string, pool?: Pool) {
    if (!connectionString.trim()) {
      throw new Error('DATABASE_URL must be configured to start the backend');
    }
    this.pool = pool ?? new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
    });
    this.pool.on('error', (error) => {
      console.error('Unexpected PostgreSQL pool error:', error);
    });
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of schema) {
        await client.query(statement);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listStudents(): Promise<Student[]> {
    const { rows } = await this.pool.query<StudentRow>(
      `SELECT ${STUDENT_COLUMNS} FROM students ORDER BY name`
    );
    return rows.map(mapStudent);
  }

  async createStudent(input: StudentInput): Promise<Student> {
    try {
      const { rows } = await this.pool.query<StudentRow>(
        `INSERT INTO students (id, name, rfid_uid, position, member_type, photo_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${STUDENT_COLUMNS}`,
        [randomUUID(), input.name, input.rfid_uid, input.position, input.member_type ?? 'OFFICER', input.photo_url ?? '']
      );
      return mapStudent(rows[0]);
    } catch (error) {
      throw mapDatabaseError(error, 'That RFID card ID is already assigned to another student');
    }
  }

  async updateStudent(id: string, input: StudentInput): Promise<Student> {
    try {
      const { rows } = await this.pool.query<StudentRow>(
        `UPDATE students
         SET name = $2, rfid_uid = $3, position = $4,
             member_type = COALESCE($5, member_type), photo_url = COALESCE($6, photo_url),
             updated_at = now()
         WHERE id = $1
         RETURNING ${STUDENT_COLUMNS}`,
        [id, input.name, input.rfid_uid, input.position, input.member_type ?? null, input.photo_url ?? null]
      );
      if (!rows[0]) {
        throw new StoreError(404, 'Student not found');
      }
      return mapStudent(rows[0]);
    } catch (error) {
      throw mapDatabaseError(error, 'That RFID card ID is already assigned to another student');
    }
  }

  async deleteStudent(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const student = await client.query(
        `SELECT id FROM students WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!student.rowCount) {
        throw new StoreError(404, 'Student not found');
      }
      const activeLog = await client.query(
        `SELECT id FROM duty_logs WHERE student_id = $1 AND status = 'ACTIVE' LIMIT 1`,
        [id]
      );
      if (activeLog.rowCount) {
        throw new StoreError(409, 'This member has an active duty log. Clock them out before removing them.');
      }
      await client.query('DELETE FROM students WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordScan(
    identifier: string,
    officerId?: string,
    fallbackOfficer?: OfficerIdentity | null
  ): Promise<DutyScanResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const studentResult = await client.query<StudentRow>(
        `SELECT ${STUDENT_COLUMNS}
         FROM students
         WHERE lower(rfid_uid) = lower($1)
         FOR UPDATE`,
        [identifier]
      );
      const student = studentResult.rows[0];
      if (!student) {
        throw new StoreError(404, 'Card not registered');
      }

      let officer = fallbackOfficer ?? null;
      if (officerId) {
        const officerResult = await client.query<StudentRow>(
          `SELECT ${STUDENT_COLUMNS} FROM students WHERE id = $1`,
          [officerId]
        );
        const selected = ensureClockingOfficer(officerResult.rows[0]);
        officer = { id: selected.id, name: selected.name };
      }

      const now = new Date();
      const activeResult = await client.query<DutyLogRow>(
        `SELECT * FROM duty_logs
         WHERE student_id = $1 AND status = 'ACTIVE'
         FOR UPDATE`,
        [student.id]
      );
      let result: DutyScanResult;

      if (activeResult.rows[0]) {
        const activeLog = mapDutyLog(activeResult.rows[0]);
        const totalDutyHours = Number(
          ((now.getTime() - new Date(activeLog.clockInTime).getTime()) / 3_600_000).toFixed(2)
        );
        const { rows } = await client.query<DutyLogRow>(
          `UPDATE duty_logs
           SET clock_out_time = $2, status = 'COMPLETED', total_duty_hours = $3,
               scanned_by_clock_out_officer_id = $4, scanned_by_clock_out_officer_name = $5,
               updated_at = $2
           WHERE id = $1
           RETURNING *`,
          [activeLog.id, now, totalDutyHours, officer?.id ?? null, officer?.name ?? null]
        );
        result = { ...mapDutyLog(rows[0]), action: 'CLOCK_OUT', timestamp: now.toISOString() };
      } else {
        const { rows } = await client.query<DutyLogRow>(
          `INSERT INTO duty_logs (
            id, student_id, student_name, rfid_uid, position, clock_in_time, status,
            scanned_by_officer_id, scanned_by_officer_name
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7, $8)
          RETURNING *`,
          [randomUUID(), student.id, student.name, student.rfid_uid, student.position, now, officer?.id ?? null, officer?.name ?? null]
        );
        result = { ...mapDutyLog(rows[0]), action: 'CLOCK_IN', timestamp: now.toISOString() };
      }

      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        throw new StoreError(409, 'A scan for this member is already being recorded. Please try again.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async createManualLog(name: string, officerId: string): Promise<DutyScanResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const officerResult = await client.query<StudentRow>(
        `SELECT ${STUDENT_COLUMNS} FROM students WHERE id = $1`,
        [officerId]
      );
      const officer = ensureClockingOfficer(officerResult.rows[0]);

      const now = new Date();
      const { rows } = await client.query<DutyLogRow>(
        `INSERT INTO duty_logs (
          id, student_id, student_name, rfid_uid, position, is_non_member, clock_in_time, status,
          scanned_by_officer_id, scanned_by_officer_name
        )
        VALUES ($1, $2, $3, '', '', true, $4, 'ACTIVE', $5, $6)
        RETURNING *`,
        [randomUUID(), randomUUID(), name, now, officer.id, officer.name]
      );
      await client.query('COMMIT');
      return { ...mapDutyLog(rows[0]), action: 'CLOCK_IN', timestamp: now.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async clockOutLog(id: string): Promise<DutyScanResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<DutyLogRow>(
        `SELECT * FROM duty_logs WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const activeLog = current.rows[0];
      if (!activeLog) {
        throw new StoreError(404, 'Duty log not found');
      }
      if (activeLog.status !== 'ACTIVE') {
        throw new StoreError(409, 'This duty log is already completed');
      }

      const now = new Date();
      const totalDutyHours = Number(
        ((now.getTime() - new Date(activeLog.clock_in_time).getTime()) / 3_600_000).toFixed(2)
      );
      const { rows } = await client.query<DutyLogRow>(
        `UPDATE duty_logs
         SET clock_out_time = $2, status = 'COMPLETED', total_duty_hours = $3, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [id, now, totalDutyHours]
      );
      await client.query('COMMIT');
      return { ...mapDutyLog(rows[0]), action: 'CLOCK_OUT', timestamp: now.toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateLogTimes(id: string, clockInTime: Date, clockOutTime: Date | null): Promise<DutyLog> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<DutyLogRow>(
        `SELECT * FROM duty_logs WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const log = current.rows[0];
      if (!log) {
        throw new StoreError(404, 'Duty log not found');
      }
      ensureEditableTimes(log.status, clockOutTime);
      await this.ensureNoStudentOverlap(client, log.student_id, clockInTime, clockOutTime, id);

      const { rows } = await client.query<DutyLogRow>(
        `UPDATE duty_logs
         SET clock_in_time = $2, clock_out_time = $3, total_duty_hours = $4, status = $5, updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          clockInTime,
          clockOutTime,
          clockOutTime ? hoursBetween(clockInTime, clockOutTime) : null,
          clockOutTime ? 'COMPLETED' : log.status
        ]
      );
      await client.query('COMMIT');
      return mapDutyLog(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createCompletedLog(studentId: string, clockInTime: Date, clockOutTime: Date): Promise<DutyLog> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const studentResult = await client.query<StudentRow>(
        `SELECT ${STUDENT_COLUMNS} FROM students WHERE id = $1 FOR UPDATE`,
        [studentId]
      );
      const student = studentResult.rows[0];
      if (!student) {
        throw new StoreError(404, 'Student not found');
      }
      await this.ensureNoStudentOverlap(client, student.id, clockInTime, clockOutTime);

      const { rows } = await client.query<DutyLogRow>(
        `INSERT INTO duty_logs (
          id, student_id, student_name, rfid_uid, position, clock_in_time, clock_out_time, status, total_duty_hours
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'COMPLETED', $8)
        RETURNING *`,
        [
          randomUUID(),
          student.id,
          student.name,
          student.rfid_uid,
          student.position,
          clockInTime,
          clockOutTime,
          hoursBetween(clockInTime, clockOutTime)
        ]
      );
      await client.query('COMMIT');
      return mapDutyLog(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureNoStudentOverlap(
    client: PoolClient,
    studentId: string,
    clockInTime: Date,
    clockOutTime: Date | null,
    exceptId?: string
  ): Promise<void> {
    // The member is matched in code: pg-mem answers student_id filters from the active-only partial index.
    const { rows } = await client.query<Pick<DutyLogRow, 'id' | 'student_id' | 'clock_in_time' | 'clock_out_time'>>(
      `SELECT id, student_id, clock_in_time, clock_out_time FROM duty_logs
       WHERE (clock_out_time IS NULL OR clock_out_time > $1)
         AND ($2::timestamptz IS NULL OR clock_in_time < $2)`,
      [clockInTime, clockOutTime]
    );
    ensureNoOverlap(
      rows.filter((row) => row.student_id === studentId && row.id !== exceptId).map((row) => ({
        clockInTime: toIso(row.clock_in_time),
        clockOutTime: row.clock_out_time === null ? undefined : toIso(row.clock_out_time)
      })),
      clockInTime,
      clockOutTime
    );
  }

  async deleteLog(id: string): Promise<void> {
    const result = await this.pool.query('DELETE FROM duty_logs WHERE id = $1', [id]);
    if (!result.rowCount) {
      throw new StoreError(404, 'Duty log not found');
    }
  }

  // Every active log is returned so nobody on duty drops off the list, followed by the latest completed ones.
  async listRecentLogs(): Promise<DutyLog[]> {
    const [active, completed] = await Promise.all([
      this.pool.query<DutyLogRow>(
        `SELECT * FROM duty_logs WHERE status = 'ACTIVE' ORDER BY clock_in_time DESC`
      ),
      this.pool.query<DutyLogRow>(
        `SELECT * FROM duty_logs WHERE status = 'COMPLETED' ORDER BY updated_at DESC LIMIT ${RECENT_COMPLETED_LIMIT}`
      )
    ]);
    return [...active.rows, ...completed.rows].map(mapDutyLog);
  }

  async listLogsBetween(from: Date, to: Date): Promise<DutyLog[]> {
    const { rows } = await this.pool.query<DutyLogRow>(
      `SELECT * FROM duty_logs
       WHERE clock_in_time >= $1 AND clock_in_time < $2
       ORDER BY clock_in_time`,
      [from, to]
    );
    return rows.map(mapDutyLog);
  }
}

export class MemoryDutyLogStore implements DutyLogStore {
  private students: Student[] = [
    { id: 'student-1', name: 'Alice Santos', rfid_uid: 'abc123', position: '', member_type: 'OFFICER', photo_url: '' },
    { id: 'student-2', name: 'Brian Cruz', rfid_uid: 'def456', position: '', member_type: 'OFFICER', photo_url: '' }
  ];
  private readonly logs: DutyLog[] = [];

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async listStudents(): Promise<Student[]> {
    return structuredClone(this.students);
  }

  async createStudent(input: StudentInput): Promise<Student> {
    this.ensureCardAvailable(input.rfid_uid);
    const student: Student = {
      id: randomUUID(),
      ...input,
      member_type: input.member_type ?? 'OFFICER',
      photo_url: input.photo_url ?? ''
    };
    this.students.push(student);
    return { ...student };
  }

  async updateStudent(id: string, input: StudentInput): Promise<Student> {
    const student = this.students.find((entry) => entry.id === id);
    if (!student) {
      throw new StoreError(404, 'Student not found');
    }
    this.ensureCardAvailable(input.rfid_uid, id);
    Object.assign(student, {
      ...input,
      member_type: input.member_type ?? student.member_type,
      photo_url: input.photo_url ?? student.photo_url
    });
    return { ...student };
  }

  async deleteStudent(id: string): Promise<void> {
    const index = this.students.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new StoreError(404, 'Student not found');
    }
    if (this.logs.some((entry) => entry.studentId === id && entry.status === 'ACTIVE')) {
      throw new StoreError(409, 'This member has an active duty log. Clock them out before removing them.');
    }
    this.students.splice(index, 1);
  }

  async recordScan(
    identifier: string,
    officerId?: string,
    fallbackOfficer?: OfficerIdentity | null
  ): Promise<DutyScanResult> {
    const student = this.students.find((entry) => entry.rfid_uid.toLowerCase() === identifier.toLowerCase());
    if (!student) {
      throw new StoreError(404, 'Card not registered');
    }
    let officer = fallbackOfficer ?? null;
    if (officerId) {
      const selected = ensureClockingOfficer(this.students.find((entry) => entry.id === officerId));
      officer = { id: selected.id, name: selected.name };
    }

    const now = new Date().toISOString();
    const activeLog = this.logs.find((entry) => entry.studentId === student.id && entry.status === 'ACTIVE');
    if (activeLog) {
      const totalDutyHours = Number(
        ((new Date(now).getTime() - new Date(activeLog.clockInTime).getTime()) / 3_600_000).toFixed(2)
      );
      activeLog.clockOutTime = now;
      activeLog.status = 'COMPLETED';
      activeLog.totalDutyHours = totalDutyHours;
      activeLog.scannedByClockOutOfficerId = officer?.id;
      activeLog.scannedByClockOutOfficerName = officer?.name;
      activeLog.updatedAt = now;
      return { ...activeLog, action: 'CLOCK_OUT', timestamp: now };
    }

    const dutyLog: DutyLog = {
      id: randomUUID(),
      studentId: student.id,
      studentName: student.name,
      rfidUid: student.rfid_uid,
      position: student.position,
      clockInTime: now,
      status: 'ACTIVE',
      scannedByOfficerId: officer?.id,
      scannedByOfficerName: officer?.name,
      createdAt: now,
      updatedAt: now
    };
    this.logs.push(dutyLog);
    return { ...dutyLog, action: 'CLOCK_IN', timestamp: now };
  }

  async createManualLog(name: string, officerId: string): Promise<DutyScanResult> {
    const officer = ensureClockingOfficer(this.students.find((entry) => entry.id === officerId));

    const now = new Date().toISOString();
    const dutyLog: DutyLog = {
      id: randomUUID(),
      studentId: randomUUID(),
      studentName: name,
      rfidUid: '',
      position: '',
      isNonMember: true,
      clockInTime: now,
      status: 'ACTIVE',
      scannedByOfficerId: officer.id,
      scannedByOfficerName: officer.name,
      createdAt: now,
      updatedAt: now
    };
    this.logs.push(dutyLog);
    return { ...dutyLog, action: 'CLOCK_IN', timestamp: now };
  }

  async clockOutLog(id: string): Promise<DutyScanResult> {
    const log = this.logs.find((entry) => entry.id === id);
    if (!log) {
      throw new StoreError(404, 'Duty log not found');
    }
    if (log.status !== 'ACTIVE') {
      throw new StoreError(409, 'This duty log is already completed');
    }

    const now = new Date().toISOString();
    log.clockOutTime = now;
    log.status = 'COMPLETED';
    log.totalDutyHours = Number(
      ((new Date(now).getTime() - new Date(log.clockInTime).getTime()) / 3_600_000).toFixed(2)
    );
    log.updatedAt = now;
    return { ...log, action: 'CLOCK_OUT', timestamp: now };
  }

  async updateLogTimes(id: string, clockInTime: Date, clockOutTime: Date | null): Promise<DutyLog> {
    const log = this.logs.find((entry) => entry.id === id);
    if (!log) {
      throw new StoreError(404, 'Duty log not found');
    }
    ensureEditableTimes(log.status, clockOutTime);
    ensureNoOverlap(
      this.logs.filter((entry) => entry.studentId === log.studentId && entry.id !== id),
      clockInTime,
      clockOutTime
    );

    log.clockInTime = clockInTime.toISOString();
    log.clockOutTime = clockOutTime?.toISOString();
    log.totalDutyHours = clockOutTime ? hoursBetween(clockInTime, clockOutTime) : undefined;
    if (clockOutTime) {
      log.status = 'COMPLETED';
    }
    log.updatedAt = new Date().toISOString();
    return structuredClone(log);
  }

  async createCompletedLog(studentId: string, clockInTime: Date, clockOutTime: Date): Promise<DutyLog> {
    const student = this.students.find((entry) => entry.id === studentId);
    if (!student) {
      throw new StoreError(404, 'Student not found');
    }
    ensureNoOverlap(this.logs.filter((entry) => entry.studentId === studentId), clockInTime, clockOutTime);

    const now = new Date().toISOString();
    const dutyLog: DutyLog = {
      id: randomUUID(),
      studentId: student.id,
      studentName: student.name,
      rfidUid: student.rfid_uid,
      position: student.position,
      clockInTime: clockInTime.toISOString(),
      clockOutTime: clockOutTime.toISOString(),
      status: 'COMPLETED',
      totalDutyHours: hoursBetween(clockInTime, clockOutTime),
      createdAt: now,
      updatedAt: now
    };
    this.logs.push(dutyLog);
    return structuredClone(dutyLog);
  }

  async deleteLog(id: string): Promise<void> {
    const index = this.logs.findIndex((entry) => entry.id === id);
    if (index === -1) {
      throw new StoreError(404, 'Duty log not found');
    }
    this.logs.splice(index, 1);
  }

  async listRecentLogs(): Promise<DutyLog[]> {
    const logs = structuredClone(this.logs);
    const active = logs
      .filter((entry) => entry.status === 'ACTIVE')
      .sort((left, right) => right.clockInTime.localeCompare(left.clockInTime));
    const completed = logs
      .filter((entry) => entry.status === 'COMPLETED')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, RECENT_COMPLETED_LIMIT);
    return [...active, ...completed];
  }

  async listLogsBetween(from: Date, to: Date): Promise<DutyLog[]> {
    return structuredClone(this.logs)
      .filter((entry) => {
        const clockIn = new Date(entry.clockInTime).getTime();
        return clockIn >= from.getTime() && clockIn < to.getTime();
      })
      .sort((left, right) => left.clockInTime.localeCompare(right.clockInTime));
  }

  private ensureCardAvailable(rfidUid: string, exceptId?: string): void {
    if (this.students.some((entry) =>
      entry.id !== exceptId && entry.rfid_uid.toLowerCase() === rfidUid.toLowerCase()
    )) {
      throw new StoreError(409, 'That RFID card ID is already assigned to another student');
    }
  }
}

function mapStudent(row: StudentRow): Student {
  return {
    id: row.id,
    name: row.name,
    rfid_uid: row.rfid_uid,
    position: row.position,
    member_type: isMemberType(row.member_type) ? row.member_type : 'OFFICER',
    photo_url: row.photo_url ?? ''
  };
}

export function isMemberType(value: unknown): value is MemberType {
  return typeof value === 'string' && (MEMBER_TYPES as readonly string[]).includes(value);
}

// Committee members can be clocked in, but only Officers and Junior Officers may record entries.
function ensureClockingOfficer<T extends Pick<Student, 'id' | 'name' | 'member_type'>>(officer: T | undefined): T {
  if (!officer) {
    throw new StoreError(400, 'Selected clocking officer is not on the roster');
  }
  if (officer.member_type === 'COMMITTEE') {
    throw new StoreError(403, 'Only Officers and Junior Officers can be the clocking officer');
  }
  return officer;
}

// A completed log cannot be reopened, since that could leave a member with two active logs.
function ensureEditableTimes(status: DutyLogStatus, clockOutTime: Date | null): void {
  if (status === 'COMPLETED' && !clockOutTime) {
    throw new StoreError(400, 'A completed duty log needs a clock-out time');
  }
}

// An open log counts as running indefinitely, so nothing may be placed after its clock-in.
function ensureNoOverlap(
  existing: Pick<DutyLog, 'clockInTime' | 'clockOutTime'>[],
  clockInTime: Date,
  clockOutTime: Date | null
): void {
  const start = clockInTime.getTime();
  const end = clockOutTime?.getTime() ?? Infinity;
  const overlaps = existing.some((entry) => {
    const entryStart = new Date(entry.clockInTime).getTime();
    const entryEnd = entry.clockOutTime ? new Date(entry.clockOutTime).getTime() : Infinity;
    return start < entryEnd && entryStart < end;
  });
  if (overlaps) {
    throw new StoreError(409, 'These times overlap another duty session for this member');
  }
}

function hoursBetween(from: Date, to: Date): number {
  return Number(((to.getTime() - from.getTime()) / 3_600_000).toFixed(2));
}

function mapDutyLog(row: DutyLogRow): DutyLog {
  return {
    id: row.id,
    studentId: row.student_id,
    studentName: row.student_name,
    rfidUid: row.rfid_uid,
    position: row.position,
    isNonMember: row.is_non_member,
    clockInTime: toIso(row.clock_in_time),
    clockOutTime: row.clock_out_time === null ? undefined : toIso(row.clock_out_time),
    status: row.status,
    totalDutyHours: row.total_duty_hours === null ? undefined : Number(row.total_duty_hours),
    scannedByOfficerId: row.scanned_by_officer_id ?? undefined,
    scannedByOfficerName: row.scanned_by_officer_name ?? undefined,
    scannedByClockOutOfficerId: row.scanned_by_clock_out_officer_id ?? undefined,
    scannedByClockOutOfficerName: row.scanned_by_clock_out_officer_name ?? undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function mapDatabaseError(error: unknown, duplicateMessage: string): unknown {
  if (error instanceof StoreError) {
    return error;
  }
  if (isUniqueViolation(error)) {
    return new StoreError(409, duplicateMessage);
  }
  return error;
}
