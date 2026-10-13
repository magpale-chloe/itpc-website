import { HttpErrorResponse } from '@angular/common/http';
import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DutyLogEntry, DutyLogService, StudentRecord } from '../duty-log.service';

@Component({
  selector: 'app-duty-log-table',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './duty-log-table.html',
  styleUrl: './duty-log-table.scss'
})
export class DutyLogTable implements OnInit {
  readonly logs = signal<DutyLogEntry[]>([]);
  readonly students = signal<StudentRecord[]>([]);
  readonly loading = signal(false);
  readonly studentLoading = signal(false);
  readonly savingStudent = signal(false);
  readonly scanPending = signal(false);
  readonly nameOnlyMode = signal(false);
  readonly canManageRoster = signal(false);
  readonly addingStudent = signal(false);
  readonly savingNewStudent = signal(false);
  readonly deletingStudentId = signal<string | null>(null);
  readonly savingManualLog = signal(false);
  readonly manualLogFormOpen = signal(false);
  readonly clockingOutLogId = signal<string | null>(null);
  readonly deletingLogId = signal<string | null>(null);
  readonly rosterOpen = signal(this.getRosterOpenPreference());
  readonly errorMessage = signal('');
  readonly studentError = signal('');
  readonly scanMessage = signal('');
  readonly scanError = signal('');
  readonly editingStudentId = signal<string | null>(null);
  readonly manualLogError = signal('');
  readonly manualLogMessage = signal('');

  scanIdentifier = '';
  manualLogName = '';
  selectedOfficerId = '';
  newStudent = { name: '', rfid_uid: '', position: '' };
  draftStudent: StudentRecord | null = null;

  constructor(private readonly dutyLogService: DutyLogService) {}

  ngOnInit(): void {
    this.canManageRoster.set(this.getSessionRole() === 'executive');
    this.loadLogs();
    this.loadStudents();

    this.dutyLogService.dutyLogUpdates$.subscribe((entry) => {
      if (!entry) {
        return;
      }

      const normalized: DutyLogEntry = {
        ...entry,
        id: entry.id ?? `${entry.studentName}-${entry.timestamp}`,
        studentId: entry.studentId ?? 'N/A'
      };
      this.logs.update((current) => [
        normalized,
        ...current.filter((existing) => existing.id !== normalized.id)
      ].slice(0, 25));
    });
  }

  loadLogs(): void {
    this.loading.set(true);
    this.errorMessage.set('');

    this.dutyLogService.getRecentLogs().subscribe({
      next: (entries) => {
        this.logs.set(entries);
        this.loading.set(false);
      },
      error: () => {
        this.errorMessage.set('Unable to load duty logs right now.');
        this.loading.set(false);
      }
    });
  }

  loadStudents(): void {
    this.studentLoading.set(true);
    this.studentError.set('');

    this.dutyLogService.getStudents().subscribe({
      next: (entries) => {
        this.students.set(entries);
        if (!entries.some((student) => student.id === this.selectedOfficerId)) {
          this.selectedOfficerId = '';
        }
        this.studentLoading.set(false);
      },
      error: () => {
        this.studentError.set('Unable to load the RFID roster right now.');
        this.studentLoading.set(false);
      }
    });
  }

  scanCard(): void {
    const identifier = this.scanIdentifier.trim();
    if (!identifier || !this.selectedOfficerId || this.scanPending()) {
      return;
    }

    this.scanPending.set(true);
    this.scanMessage.set('');
    this.scanError.set('');
    if (this.nameOnlyMode()) {
      this.dutyLogService.createManualLog(identifier, this.selectedOfficerId).subscribe({
        next: (entry) => {
          this.scanMessage.set(`${entry.studentName} clocked in at ${this.formatTimestamp(entry.timestamp)}.`);
          this.scanIdentifier = '';
          this.scanPending.set(false);
        },
        error: (error: HttpErrorResponse) => {
          this.scanError.set(this.getManualLogErrorMessage(error));
          this.scanPending.set(false);
        }
      });
      return;
    }

    this.dutyLogService.postDutyLog({ identifier, officerId: this.selectedOfficerId }).subscribe({
      next: (entry) => {
        const time = this.formatTimestamp(entry.timestamp);
        this.scanMessage.set(entry.action === 'CLOCK_IN'
          ? `${entry.studentName} clocked in at ${time}.`
          : `${entry.studentName} clocked out at ${time}. Total: ${entry.totalDutyHours ?? 0} hours.`);
        this.scanIdentifier = '';
        this.scanPending.set(false);
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.scanError.set(apiMessage || 'Unable to record this RFID scan.');
        this.scanPending.set(false);
      }
    });
  }

  toggleNameOnlyMode(): void {
    this.nameOnlyMode.update((isNameOnly) => !isNameOnly);
    this.scanIdentifier = '';
    this.scanMessage.set('');
    this.scanError.set('');
  }

  addManualLog(): void {
    const name = this.manualLogName.trim();
    if (!name || !this.selectedOfficerId || this.savingManualLog()) {
      return;
    }

    this.savingManualLog.set(true);
    this.manualLogError.set('');
    this.manualLogMessage.set('');
    this.dutyLogService.createManualLog(name, this.selectedOfficerId).subscribe({
      next: (entry) => {
        this.manualLogName = '';
        this.manualLogFormOpen.set(false);
        this.manualLogMessage.set(`${entry.studentName} was clocked in manually.`);
        this.savingManualLog.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.manualLogError.set(this.getManualLogErrorMessage(error));
        this.savingManualLog.set(false);
      }
    });
  }

  clockOutLog(entry: DutyLogEntry): void {
    if (!entry.id || this.clockingOutLogId() || !window.confirm(`Clock out ${entry.studentName} now?`)) {
      return;
    }

    this.clockingOutLogId.set(entry.id);
    this.manualLogError.set('');
    this.dutyLogService.clockOutLog(entry.id).subscribe({
      next: () => this.clockingOutLogId.set(null),
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.manualLogError.set(apiMessage || `Unable to clock out ${entry.studentName}.`);
        this.clockingOutLogId.set(null);
      }
    });
  }

  deleteLog(entry: DutyLogEntry): void {
    if (!entry.id || this.deletingLogId() || !window.confirm(`Permanently delete the duty log for ${entry.studentName}?`)) {
      return;
    }

    this.deletingLogId.set(entry.id);
    this.manualLogError.set('');
    this.dutyLogService.deleteLog(entry.id).subscribe({
      next: () => {
        this.logs.update((current) => current.filter((log) => log.id !== entry.id));
        this.deletingLogId.set(null);
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.manualLogError.set(apiMessage || `Unable to delete the duty log for ${entry.studentName}.`);
        this.deletingLogId.set(null);
      }
    });
  }

  beginEdit(student: StudentRecord): void {
    this.studentError.set('');
    this.editingStudentId.set(student.id);
    this.draftStudent = { ...student };
  }

  toggleAddStudent(): void {
    this.studentError.set('');
    this.addingStudent.update((adding) => !adding);
    this.newStudent = { name: '', rfid_uid: '', position: '' };
  }

  toggleRoster(): void {
    const isOpen = !this.rosterOpen();
    this.rosterOpen.set(isOpen);
    try {
      localStorage.setItem('itpc-admin-roster-open', String(isOpen));
    } catch (error) {
      console.error('Unable to save RFID roster visibility preference:', error);
    }
  }

  toggleManualLogForm(): void {
    this.manualLogError.set('');
    this.manualLogFormOpen.update((isOpen) => !isOpen);
  }

  addStudent(): void {
    const student = {
      name: this.newStudent.name.trim(),
      rfid_uid: this.newStudent.rfid_uid.trim(),
      position: this.newStudent.position.trim()
    };
    if (!student.name || !student.rfid_uid || this.savingNewStudent()) {
      return;
    }

    this.savingNewStudent.set(true);
    this.studentError.set('');
    this.dutyLogService.createStudent(student).subscribe({
      next: (createdStudent) => {
        this.students.update((current) => [...current, createdStudent]);
        this.addingStudent.set(false);
        this.newStudent = { name: '', rfid_uid: '', position: '' };
        this.savingNewStudent.set(false);
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.studentError.set(apiMessage || 'Unable to register this RFID card.');
        this.savingNewStudent.set(false);
      }
    });
  }

  cancelEdit(): void {
    this.editingStudentId.set(null);
    this.draftStudent = null;
  }

  saveStudent(): void {
    if (!this.draftStudent || this.savingStudent()) {
      return;
    }

    const updatedStudent = { ...this.draftStudent };
    this.savingStudent.set(true);
    this.studentError.set('');
    this.dutyLogService.updateStudent(updatedStudent).subscribe({
      next: (savedStudent) => {
        this.students.update((current) => current.map((student) =>
          student.id === savedStudent.id ? savedStudent : student
        ));
        this.cancelEdit();
        this.savingStudent.set(false);
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.studentError.set(apiMessage || 'Unable to save this roster entry.');
        this.savingStudent.set(false);
      }
    });
  }

  deleteStudent(student: StudentRecord): void {
    if (this.deletingStudentId() || !window.confirm(`Delete ${student.name} and their RFID card assignment?`)) {
      return;
    }

    this.studentError.set('');
    this.deletingStudentId.set(student.id);
    this.dutyLogService.deleteStudent(student.id).subscribe({
      next: () => {
        this.students.update((current) => current.filter((entry) => entry.id !== student.id));
        if (this.selectedOfficerId === student.id) {
          this.selectedOfficerId = '';
        }
        this.deletingStudentId.set(null);
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.studentError.set(apiMessage || 'Unable to delete this roster member.');
        this.deletingStudentId.set(null);
      }
    });
  }

  formatOfficer(entry: DutyLogEntry | null | undefined): string {
    if (!entry) {
      return '—';
    }

    return entry.scannedByOfficerName || entry.scannedByOfficerId || '—';
  }

  formatClockOutOfficer(entry: DutyLogEntry | null | undefined): string {
    if (!entry) {
      return '—';
    }

    return entry.scannedByClockOutOfficerName || entry.scannedByClockOutOfficerId || '—';
  }

  formatTimestamp(value?: string): string {
    if (!value) {
      return '—';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  getDutyStatusLabel(entry: DutyLogEntry): string {
    return entry.status === 'ACTIVE' ? 'ACTIVE' : 'COMPLETED';
  }

  private getSessionRole(): string | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }

    try {
      const user = JSON.parse(sessionStorage.getItem('itpc-session-user') ?? '{}') as { role?: unknown };
      return typeof user.role === 'string' ? user.role : null;
    } catch {
      return null;
    }
  }

  private getRosterOpenPreference(): boolean {
    if (typeof localStorage === 'undefined') {
      return true;
    }

    try {
      return localStorage.getItem('itpc-admin-roster-open') !== 'false';
    } catch (error) {
      console.error('Unable to read RFID roster visibility preference:', error);
      return true;
    }
  }

  private getManualLogErrorMessage(error: HttpErrorResponse): string {
    if (typeof error.error?.error === 'string') {
      return error.error.error;
    }
    if (error.status === 0) {
      return 'Cannot reach the backend. It may be waking up; wait a moment and try again.';
    }
    if (error.status === 404) {
      return 'The backend is missing the name-only log endpoint. Redeploy the latest backend code, then try again.';
    }
    return `Unable to record the name-only entry (HTTP ${error.status}).`;
  }
}
