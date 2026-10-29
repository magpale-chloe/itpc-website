import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { BehaviorSubject, Observable, tap } from 'rxjs';
import { PHOTO_API_BASE_URL } from './api.config';

export type DutyLogAction = 'CLOCK_IN' | 'CLOCK_OUT';

export interface DutyLogRequest {
  identifier?: string;
  tag_id?: string;
  rfid_uid?: string;
  card_id?: string;
  officerId?: string;
}

export interface DutyLogEntry {
  id?: string;
  studentId?: string;
  studentName: string;
  rfidUid?: string;
  position?: string;
  action: DutyLogAction;
  timestamp: string;
  totalDutyHours?: number;
  logId?: string;
  status?: 'ACTIVE' | 'COMPLETED';
  isNonMember?: boolean;
  scannedByOfficerId?: string;
  scannedByOfficerName?: string;
  scannedByClockOutOfficerId?: string;
  scannedByClockOutOfficerName?: string;
  clockInTime?: string;
  clockOutTime?: string;
}

export type MemberType = 'OFFICER' | 'JUNIOR_OFFICER' | 'COMMITTEE';

export const MEMBER_TYPE_OPTIONS: readonly { value: MemberType; label: string }[] = [
  { value: 'OFFICER', label: 'Officer' },
  { value: 'JUNIOR_OFFICER', label: 'Junior Officer' },
  { value: 'COMMITTEE', label: 'Committee' }
];

// Junior Officers and Committee members must render this many duty hours each week.
export const REQUIRED_WEEKLY_HOURS = 5;

export interface StudentRecord {
  id: string;
  name: string;
  rfid_uid: string;
  position: string;
  member_type: MemberType;
  photo_url: string;
}

export function memberTypeLabel(type: MemberType | undefined): string {
  return MEMBER_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? 'Officer';
}

export function canBeClockingOfficer(student: StudentRecord): boolean {
  return student.member_type !== 'COMMITTEE';
}

export function hasWeeklyRequirement(student: StudentRecord): boolean {
  return student.member_type === 'JUNIOR_OFFICER' || student.member_type === 'COMMITTEE';
}

export function memberInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}

@Injectable({ providedIn: 'root' })
export class DutyLogService {
  private readonly http = inject(HttpClient);
  private readonly dutyLogSubject = new BehaviorSubject<DutyLogEntry | null>(null);

  readonly dutyLogUpdates$ = this.dutyLogSubject.asObservable();

  getStudents(): Observable<StudentRecord[]> {
    return this.http.get<StudentRecord[]>(`${PHOTO_API_BASE_URL}/api/students`);
  }

  createStudent(student: Omit<StudentRecord, 'id'>): Observable<StudentRecord> {
    return this.http.post<StudentRecord>(`${PHOTO_API_BASE_URL}/api/students`, student, {
      headers: this.authHeaders()
    });
  }

  updateStudent(student: StudentRecord): Observable<StudentRecord> {
    return this.http.patch<StudentRecord>(`${PHOTO_API_BASE_URL}/api/students/${encodeURIComponent(student.id)}`, {
      name: student.name,
      rfid_uid: student.rfid_uid,
      position: student.position,
      member_type: student.member_type,
      photo_url: student.photo_url
    }, {
      headers: this.authHeaders()
    });
  }

  deleteStudent(studentId: string): Observable<void> {
    return this.http.delete<void>(`${PHOTO_API_BASE_URL}/api/students/${encodeURIComponent(studentId)}`, {
      headers: this.authHeaders()
    });
  }

  createManualLog(name: string, officerId: string): Observable<DutyLogEntry> {
    return this.http.post<DutyLogEntry>(`${PHOTO_API_BASE_URL}/api/duty-log/manual`, { name, officerId }, {
      headers: this.authHeaders()
    }).pipe(tap((entry) => this.dutyLogSubject.next(entry)));
  }

  clockOutLog(logId: string): Observable<DutyLogEntry> {
    return this.http.patch<DutyLogEntry>(
      `${PHOTO_API_BASE_URL}/api/duty-log/${encodeURIComponent(logId)}/clock-out`,
      {},
      { headers: this.authHeaders() }
    ).pipe(tap((entry) => this.dutyLogSubject.next(entry)));
  }

  updateLogTimes(logId: string, clockInTime: string, clockOutTime: string | null): Observable<DutyLogEntry> {
    return this.http.patch<DutyLogEntry>(
      `${PHOTO_API_BASE_URL}/api/duty-log/${encodeURIComponent(logId)}`,
      { clockInTime, clockOutTime },
      { headers: this.authHeaders() }
    );
  }

  deleteLog(logId: string): Observable<void> {
    return this.http.delete<void>(`${PHOTO_API_BASE_URL}/api/duty-log/${encodeURIComponent(logId)}`, {
      headers: this.authHeaders()
    });
  }

  getRecentLogs(): Observable<DutyLogEntry[]> {
    return this.http.get<DutyLogEntry[]>(`${PHOTO_API_BASE_URL}/api/duty-log/recent`);
  }

  getLogsBetween(from: Date, to: Date): Observable<DutyLogEntry[]> {
    return this.http.get<DutyLogEntry[]>(`${PHOTO_API_BASE_URL}/api/duty-log`, {
      params: { from: from.toISOString(), to: to.toISOString() }
    });
  }

  postDutyLog(payload: DutyLogRequest): Observable<DutyLogEntry> {
    return this.http.post<DutyLogEntry>(`${PHOTO_API_BASE_URL}/api/duty-log`, payload).pipe(
      tap((entry) => this.dutyLogSubject.next(entry))
    );
  }

  notifyDutyLog(entry: DutyLogEntry): void {
    this.dutyLogSubject.next(entry);
  }

  get latestDutyLog(): DutyLogEntry | null {
    return this.dutyLogSubject.getValue();
  }

  private authHeaders(): { Authorization?: string } {
    const token = sessionStorage.getItem('itpc-session-token');
    return token ? { Authorization: 'Bearer ' + token } : {};
  }
}
