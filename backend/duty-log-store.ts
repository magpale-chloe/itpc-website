import { randomUUID } from 'node:crypto';
import { Collection, Filter, MongoClient } from 'mongodb';

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

type StudentDocument = {
  _id: string;
  name: string;
  rfid_uid: string;
  // Lowercased copy of rfid_uid so a unique index can enforce case-insensitive card IDs.
  rfid_uid_lower: string;
  position: string;
  member_type: MemberType;
  photo_url: string;
  created_at: Date;
  updated_at: Date;
};

type DutyLogDocument = {
  _id: string;
  student_id: string;
  student_name: string;
  rfid_uid: string;
  position: string;
  is_non_member: boolean;
  clock_in_time: Date;
  clock_out_time: Date | null;
  status: DutyLogStatus;
  total_duty_hours: number | null;
  scanned_by_officer_id: string | null;
  scanned_by_officer_name: string | null;
  scanned_by_clock_out_officer_id: string | null;
  scanned_by_clock_out_officer_name: string | null;
  created_at: Date;
  updated_at: Date;
};

const RECENT_COMPLETED_LIMIT = 50;
const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface MongoDutyLogStoreOptions {
  // Database to use; defaults to the database named in the connection URI.
  dbName?: string;
}

// Every write is a single-document operation guarded by unique indexes, so this works on
// standalone MongoDB servers as well as replica sets and Atlas (no transactions required).
export class MongoDutyLogStore implements DutyLogStore {
  private readonly client: MongoClient;
  private readonly students: Collection<StudentDocument>;
  private readonly logs: Collection<DutyLogDocument>;

  constructor(uri: string, options: MongoDutyLogStoreOptions = {}) {
    if (!uri.trim()) {
      throw new Error('MONGODB_URI must be configured to start the backend');
    }
    this.client = new MongoClient(uri);
    const db = this.client.db(options.dbName || undefined);
    this.students = db.collection<StudentDocument>('students');
    this.logs = db.collection<DutyLogDocument>('duty_logs');
  }

  async initialize(): Promise<void> {
    await this.client.connect();
    await Promise.all([
      this.students.createIndex({ rfid_uid_lower: 1 }, { unique: true, name: 'students_rfid_uid_lower_unique' }),
      this.logs.createIndex(
        { student_id: 1 },
        { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'duty_logs_one_active_per_student' }
      ),
      this.logs.createIndex({ student_id: 1, clock_in_time: 1 }, { name: 'duty_logs_student_clock_in' }),
      this.logs.createIndex({ status: 1, updated_at: -1 }, { name: 'duty_logs_status_updated_at' }),
      this.logs.createIndex({ clock_in_time: 1 }, { name: 'duty_logs_clock_in_time' })
    ]);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listStudents(): Promise<Student[]> {
    const documents = await this.students.find().sort({ name: 1 }).collation(NAME_COLLATION).toArray();
    return documents.map(mapStudent);
  }

  async createStudent(input: StudentInput): Promise<Student> {
    const now = new Date();
    const document: StudentDocument = {
      _id: randomUUID(),
      name: input.name,
      rfid_uid: input.rfid_uid,
      rfid_uid_lower: input.rfid_uid.toLowerCase(),
      position: input.position,
      member_type: input.member_type ?? 'OFFICER',
      photo_url: input.photo_url ?? '',
      created_at: now,
      updated_at: now
    };
    try {
      await this.students.insertOne(document);
    } catch (error) {
      throw mapDatabaseError(error, 'That RFID card ID is already assigned to another student');
    }
    return mapStudent(document);
  }

  async updateStudent(id: string, input: StudentInput): Promise<Student> {
    const changes: Partial<StudentDocument> = {
      name: input.name,
      rfid_uid: input.rfid_uid,
      rfid_uid_lower: input.rfid_uid.toLowerCase(),
      position: input.position,
      updated_at: new Date()
    };
    if (input.member_type !== undefined) {
      changes.member_type = input.member_type;
    }
    if (input.photo_url !== undefined) {
      changes.photo_url = input.photo_url;
    }

    let updated: StudentDocument | null;
    try {
      updated = await this.students.findOneAndUpdate({ _id: id }, { $set: changes }, { returnDocument: 'after' });
    } catch (error) {
      throw mapDatabaseError(error, 'That RFID card ID is already assigned to another student');
    }
    if (!updated) {
      throw new StoreError(404, 'Student not found');
    }
    return mapStudent(updated);
  }

  async deleteStudent(id: string): Promise<void> {
    if (!(await this.findStudent(id))) {
      throw new StoreError(404, 'Student not found');
    }
    if (await this.logs.findOne({ student_id: id, status: 'ACTIVE' }, { projection: { _id: 1 } })) {
      throw new StoreError(409, 'This member has an active duty log. Clock them out before removing them.');
    }
    await this.students.deleteOne({ _id: id });
  }

  async recordScan(
    identifier: string,
    officerId?: string,
    fallbackOfficer?: OfficerIdentity | null
  ): Promise<DutyScanResult> {
    const studentDocument = await this.students.findOne({ rfid_uid_lower: identifier.toLowerCase() });
    if (!studentDocument) {
      throw new StoreError(404, 'Card not registered');
    }
    const student = mapStudent(studentDocument);

    let officer = fallbackOfficer ?? null;
    if (officerId) {
      const selected = ensureClockingOfficer(await this.findStudent(officerId));
      officer = { id: selected.id, name: selected.name };
    }

    const now = new Date();
    const activeLog = await this.logs.findOne({ student_id: student.id, status: 'ACTIVE' });
    if (activeLog) {
      // Matching on status means a concurrent scan that already clocked this log out wins.
      const completed = await this.logs.findOneAndUpdate(
        { _id: activeLog._id, status: 'ACTIVE' },
        {
          $set: {
            clock_out_time: now,
            status: 'COMPLETED',
            total_duty_hours: hoursBetween(activeLog.clock_in_time, now),
            scanned_by_clock_out_officer_id: officer?.id ?? null,
            scanned_by_clock_out_officer_name: officer?.name ?? null,
            updated_at: now
          }
        },
        { returnDocument: 'after' }
      );
      if (!completed) {
        throw new StoreError(409, 'A scan for this member is already being recorded. Please try again.');
      }
      return { ...mapDutyLog(completed), action: 'CLOCK_OUT', timestamp: now.toISOString() };
    }

    const document = newLogDocument({
      student_id: student.id,
      student_name: student.name,
      rfid_uid: student.rfid_uid,
      position: student.position,
      clock_in_time: now,
      status: 'ACTIVE',
      scanned_by_officer_id: officer?.id ?? null,
      scanned_by_officer_name: officer?.name ?? null
    }, now);
    try {
      await this.logs.insertOne(document);
    } catch (error) {
      throw mapDatabaseError(error, 'A scan for this member is already being recorded. Please try again.');
    }
    return { ...mapDutyLog(document), action: 'CLOCK_IN', timestamp: now.toISOString() };
  }

  async createManualLog(name: string, officerId: string): Promise<DutyScanResult> {
    const officer = ensureClockingOfficer(await this.findStudent(officerId));
    const now = new Date();
    const document = newLogDocument({
      student_id: randomUUID(),
      student_name: name,
      rfid_uid: '',
      position: '',
      is_non_member: true,
      clock_in_time: now,
      status: 'ACTIVE',
      scanned_by_officer_id: officer.id,
      scanned_by_officer_name: officer.name
    }, now);
    await this.logs.insertOne(document);
    return { ...mapDutyLog(document), action: 'CLOCK_IN', timestamp: now.toISOString() };
  }

  async clockOutLog(id: string): Promise<DutyScanResult> {
    const activeLog = await this.logs.findOne({ _id: id });
    if (!activeLog) {
      throw new StoreError(404, 'Duty log not found');
    }
    if (activeLog.status !== 'ACTIVE') {
      throw new StoreError(409, 'This duty log is already completed');
    }

    const now = new Date();
    const completed = await this.logs.findOneAndUpdate(
      { _id: id, status: 'ACTIVE' },
      {
        $set: {
          clock_out_time: now,
          status: 'COMPLETED',
          total_duty_hours: hoursBetween(activeLog.clock_in_time, now),
          updated_at: now
        }
      },
      { returnDocument: 'after' }
    );
    if (!completed) {
      throw new StoreError(409, 'This duty log is already completed');
    }
    return { ...mapDutyLog(completed), action: 'CLOCK_OUT', timestamp: now.toISOString() };
  }

  async updateLogTimes(id: string, clockInTime: Date, clockOutTime: Date | null): Promise<DutyLog> {
    const log = await this.logs.findOne({ _id: id });
    if (!log) {
      throw new StoreError(404, 'Duty log not found');
    }
    ensureEditableTimes(log.status, clockOutTime);
    await this.ensureNoStudentOverlap(log.student_id, clockInTime, clockOutTime, id);

    const updated = await this.logs.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          clock_in_time: clockInTime,
          clock_out_time: clockOutTime,
          total_duty_hours: clockOutTime ? hoursBetween(clockInTime, clockOutTime) : null,
          status: clockOutTime ? 'COMPLETED' : log.status,
          updated_at: new Date()
        }
      },
      { returnDocument: 'after' }
    );
    if (!updated) {
      throw new StoreError(404, 'Duty log not found');
    }
    return mapDutyLog(updated);
  }

  async createCompletedLog(studentId: string, clockInTime: Date, clockOutTime: Date): Promise<DutyLog> {
    const student = await this.findStudent(studentId);
    if (!student) {
      throw new StoreError(404, 'Student not found');
    }
    await this.ensureNoStudentOverlap(student.id, clockInTime, clockOutTime);

    const document = newLogDocument({
      student_id: student.id,
      student_name: student.name,
      rfid_uid: student.rfid_uid,
      position: student.position,
      clock_in_time: clockInTime,
      clock_out_time: clockOutTime,
      status: 'COMPLETED',
      total_duty_hours: hoursBetween(clockInTime, clockOutTime)
    }, new Date());
    await this.logs.insertOne(document);
    return mapDutyLog(document);
  }

  async deleteLog(id: string): Promise<void> {
    const result = await this.logs.deleteOne({ _id: id });
    if (!result.deletedCount) {
      throw new StoreError(404, 'Duty log not found');
    }
  }

  // Every active log is returned so nobody on duty drops off the list, followed by the latest completed ones.
  async listRecentLogs(): Promise<DutyLog[]> {
    const [active, completed] = await Promise.all([
      this.logs.find({ status: 'ACTIVE' }).sort({ clock_in_time: -1 }).toArray(),
      this.logs.find({ status: 'COMPLETED' }).sort({ updated_at: -1 }).limit(RECENT_COMPLETED_LIMIT).toArray()
    ]);
    return [...active, ...completed].map(mapDutyLog);
  }

  async listLogsBetween(from: Date, to: Date): Promise<DutyLog[]> {
    const documents = await this.logs
      .find({ clock_in_time: { $gte: from, $lt: to } })
      .sort({ clock_in_time: 1 })
      .toArray();
    return documents.map(mapDutyLog);
  }

  private async findStudent(id: string): Promise<Student | undefined> {
    const document = await this.students.findOne({ _id: id });
    return document ? mapStudent(document) : undefined;
  }

  private async ensureNoStudentOverlap(
    studentId: string,
    clockInTime: Date,
    clockOutTime: Date | null,
    exceptId?: string
  ): Promise<void> {
    const filter: Filter<DutyLogDocument> = {
      student_id: studentId,
      $or: [{ clock_out_time: null }, { clock_out_time: { $gt: clockInTime } }]
    };
    if (clockOutTime) {
      filter.clock_in_time = { $lt: clockOutTime };
    }
    if (exceptId) {
      filter._id = { $ne: exceptId };
    }
    const documents = await this.logs
      .find(filter, { projection: { clock_in_time: 1, clock_out_time: 1 } })
      .toArray();
    ensureNoOverlap(
      documents.map((document) => ({
        clockInTime: document.clock_in_time.toISOString(),
        clockOutTime: document.clock_out_time?.toISOString()
      })),
      clockInTime,
      clockOutTime
    );
  }
}

function newLogDocument(
  fields: Pick<DutyLogDocument, 'student_id' | 'student_name' | 'rfid_uid' | 'position' | 'clock_in_time' | 'status'> &
    Partial<DutyLogDocument>,
  now: Date
): DutyLogDocument {
  return {
    _id: randomUUID(),
    is_non_member: false,
    clock_out_time: null,
    total_duty_hours: null,
    scanned_by_officer_id: null,
    scanned_by_officer_name: null,
    scanned_by_clock_out_officer_id: null,
    scanned_by_clock_out_officer_name: null,
    created_at: now,
    updated_at: now,
    ...fields
  };
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

function mapStudent(document: StudentDocument): Student {
  return {
    id: document._id,
    name: document.name,
    rfid_uid: document.rfid_uid,
    position: document.position ?? '',
    member_type: isMemberType(document.member_type) ? document.member_type : 'OFFICER',
    photo_url: document.photo_url ?? ''
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

function mapDutyLog(document: DutyLogDocument): DutyLog {
  return {
    id: document._id,
    studentId: document.student_id,
    studentName: document.student_name,
    rfidUid: document.rfid_uid,
    position: document.position,
    isNonMember: document.is_non_member,
    clockInTime: document.clock_in_time.toISOString(),
    clockOutTime: document.clock_out_time?.toISOString(),
    status: document.status,
    totalDutyHours: document.total_duty_hours ?? undefined,
    scannedByOfficerId: document.scanned_by_officer_id ?? undefined,
    scannedByOfficerName: document.scanned_by_officer_name ?? undefined,
    scannedByClockOutOfficerId: document.scanned_by_clock_out_officer_id ?? undefined,
    scannedByClockOutOfficerName: document.scanned_by_clock_out_officer_name ?? undefined,
    createdAt: document.created_at.toISOString(),
    updatedAt: document.updated_at.toISOString()
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function mapDatabaseError(error: unknown, duplicateMessage: string): unknown {
  if (error instanceof StoreError) {
    return error;
  }
  if (isDuplicateKeyError(error)) {
    return new StoreError(409, duplicateMessage);
  }
  return error;
}
