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

export interface StudentRecord {
  id: string;
  name: string;
  rfid_uid: string;
  position: string;
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
      position: student.position
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

  deleteLog(logId: string): Observable<void> {
    return this.http.delete<void>(`${PHOTO_API_BASE_URL}/api/duty-log/${encodeURIComponent(logId)}`, {
      headers: this.authHeaders()
    });
  }

  getRecentLogs(): Observable<DutyLogEntry[]> {
    return this.http.get<DutyLogEntry[]>(`${PHOTO_API_BASE_URL}/api/duty-log/recent`);
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
