import { NgTemplateOutlet } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectorRef,
  Component,
  Injector,
  OnDestroy,
  OnInit,
  afterNextRender,
  computed,
  inject,
  signal
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  COMMITTEE_POSITIONS,
  DutyLogEntry,
  DutyLogService,
  MEMBER_TYPE_OPTIONS,
  MemberType,
  StudentRecord,
  canBeClockingOfficer,
  isCommitteePosition,
  memberBadgeLabel,
  memberBadgeTone,
  memberInitials,
  memberTypeLabel
} from '../duty-log.service';
import { resizeMemberPhoto } from '../member-photo';

type LogStatusFilter = 'ALL' | 'ACTIVE' | 'COMPLETED';
type LogTypeFilter = 'ALL' | MemberType | 'NON_MEMBER';
type NewStudent = Omit<StudentRecord, 'id'>;

interface ScanFlash {
  name: string;
  position: string;
  typeLabel: string;
  photoUrl: string;
  action: DutyLogEntry['action'];
  time: string;
  totalDutyHours?: number;
}

const SCAN_FLASH_MS = 4000;
// Keyboard-style RFID readers type each character within a few milliseconds; people type far slower.
const READER_KEY_GAP_MS = 60;
const MIN_CARD_ID_LENGTH = 4;
const NON_TEXT_INPUT_TYPES = ['button', 'checkbox', 'color', 'file', 'radio', 'range', 'reset', 'submit'];

@Component({
  selector: 'app-duty-log-table',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './duty-log-table.html',
  styleUrl: './duty-log-table.scss',
  host: { '(document:keydown)': 'captureReaderScan($event)' }
})
export class DutyLogTable implements OnInit, OnDestroy {
  readonly memberTypeOptions = MEMBER_TYPE_OPTIONS;
  readonly memberInitials = memberInitials;
  readonly memberTypeLabel = memberTypeLabel;
  readonly memberBadgeLabel = memberBadgeLabel;
  readonly memberBadgeTone = memberBadgeTone;
  readonly committeePositions = COMMITTEE_POSITIONS;
  readonly logs = signal<DutyLogEntry[]>([]);
  readonly students = signal<StudentRecord[]>([]);
  readonly studentsById = computed(() => new Map(this.students().map((student) => [student.id, student])));
  readonly clockingOfficers = computed(() => this.students().filter(canBeClockingOfficer));
  readonly rosterFilter = signal<MemberType | 'ALL'>('ALL');
  readonly filteredStudents = computed(() => {
    const filter = this.rosterFilter();
    return filter === 'ALL' ? this.students() : this.students().filter((student) => student.member_type === filter);
  });
  readonly logSearch = signal('');
  readonly logStatusFilter = signal<LogStatusFilter>('ALL');
  readonly logTypeFilter = signal<LogTypeFilter>('ALL');
  readonly activeLogCount = computed(() => this.logs().filter((log) => log.status === 'ACTIVE').length);
  readonly filteredLogs = computed(() => {
    const search = this.logSearch().trim().toLowerCase();
    const status = this.logStatusFilter();
    const type = this.logTypeFilter();
    return this.logs()
      .filter((log) => status === 'ALL' || (status === 'ACTIVE') === (log.status === 'ACTIVE'))
      .filter((log) => type === 'ALL' || this.getLogType(log) === type)
      .filter((log) => !search || [log.studentName, log.rfidUid, log.position, log.scannedByOfficerName]
        .some((value) => value?.toLowerCase().includes(search)))
      .sort((left, right) => {
        const leftActive = left.status === 'ACTIVE';
        if (leftActive !== (right.status === 'ACTIVE')) {
          return leftActive ? -1 : 1;
        }
        const leftTime = leftActive ? left.clockInTime ?? left.timestamp : left.clockOutTime ?? left.timestamp;
        const rightTime = leftActive ? right.clockInTime ?? right.timestamp : right.clockOutTime ?? right.timestamp;
        return rightTime.localeCompare(leftTime);
      });
  });
  readonly scanFlash = signal<ScanFlash | null>(null);
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
  newStudent: NewStudent = this.emptyStudent();
  draftStudent: StudentRecord | null = null;
  private scanFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private readerBuffer = '';
  private lastReaderKeyAt = 0;
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly injector = inject(Injector);

  constructor(private readonly dutyLogService: DutyLogService) {}

  ngOnDestroy(): void {
    this.dismissScanFlash();
  }

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
      ]);
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
        if (!this.clockingOfficers().some((student) => student.id === this.selectedOfficerId)) {
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
        this.showScanFlash(entry, time);
        this.scanIdentifier = '';
        this.scanPending.set(false);
        this.refocusScanInput();
      },
      error: (error: HttpErrorResponse) => {
        const apiMessage = typeof error.error?.error === 'string' ? error.error.error : '';
        this.scanError.set(apiMessage || 'Unable to record this RFID scan.');
        this.scanPending.set(false);
        this.refocusScanInput();
      }
    });
  }

  // Lets a card be scanned without focusing the card ID box. Text fields keep their keys, so typing a
  // card ID into a roster form still works; elsewhere a fast burst of keys ending in Enter is a scan.
  captureReaderScan(event: KeyboardEvent): void {
    if (this.nameOnlyMode() || event.ctrlKey || event.altKey || event.metaKey || isTextEntry(event.target)) {
      this.readerBuffer = '';
      return;
    }
    if (event.timeStamp - this.lastReaderKeyAt > READER_KEY_GAP_MS) {
      this.readerBuffer = '';
    }
    this.lastReaderKeyAt = event.timeStamp;

    if (event.key !== 'Enter') {
      if (event.key.length === 1) {
        this.readerBuffer += event.key;
      }
      return;
    }
    const identifier = this.readerBuffer.trim();
    this.readerBuffer = '';
    if (identifier.length < MIN_CARD_ID_LENGTH) {
      return;
    }
    // Stop the Enter from also clicking whatever button has focus.
    event.preventDefault();
    if (this.scanPending()) {
      return;
    }
    if (!this.selectedOfficerId) {
      this.scanMessage.set('');
      this.scanError.set('Select the clocking officer before scanning a card.');
      return;
    }
    this.scanIdentifier = identifier;
    this.scanCard();
  }

  // Moves focus off the officer picker once chosen, so a scan can't change the selection by type-ahead.
  onOfficerSelected(): void {
    this.refocusScanInput();
  }

  // The input is disabled while a scan records, which drops focus; restore it so the next card can be tapped.
  private refocusScanInput(): void {
    afterNextRender(() => document.getElementById('rfid-identifier')?.focus(), { injector: this.injector });
  }

  dismissScanFlash(): void {
    if (this.scanFlashTimer) {
      clearTimeout(this.scanFlashTimer);
      this.scanFlashTimer = null;
    }
    this.scanFlash.set(null);
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

  // Switching to Committee drops a free-text position so a committee has to be picked from the list.
  clearNonCommitteePosition(target: Pick<StudentRecord, 'member_type' | 'position'>): void {
    if (target.member_type === 'COMMITTEE' && !isCommitteePosition(target.position)) {
      target.position = '';
    }
  }

  hasValidPosition(target: Pick<StudentRecord, 'member_type' | 'position'>): boolean {
    return target.member_type !== 'COMMITTEE' || isCommitteePosition(target.position);
  }

  beginEdit(student: StudentRecord): void {
    this.studentError.set('');
    this.editingStudentId.set(student.id);
    this.draftStudent = { ...student };
  }

  toggleAddStudent(): void {
    this.studentError.set('');
    this.addingStudent.update((adding) => !adding);
    this.newStudent = this.emptyStudent();
  }

  async onPhotoSelected(event: Event, target: Pick<StudentRecord, 'photo_url'>): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    this.studentError.set('');
    try {
      target.photo_url = await resizeMemberPhoto(file);
      this.changeDetector.markForCheck();
    } catch (error) {
      this.studentError.set(error instanceof Error ? error.message : 'Unable to use that photo.');
    }
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
    const student: NewStudent = {
      ...this.newStudent,
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
        this.newStudent = this.emptyStudent();
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

  getLogMember(entry: DutyLogEntry): StudentRecord | undefined {
    return entry.isNonMember || !entry.studentId ? undefined : this.studentsById().get(entry.studentId);
  }

  clearLogFilters(): void {
    this.logSearch.set('');
    this.logStatusFilter.set('ALL');
    this.logTypeFilter.set('ALL');
  }

  private getLogType(entry: DutyLogEntry): LogTypeFilter {
    return entry.isNonMember ? 'NON_MEMBER' : this.getLogMember(entry)?.member_type ?? 'OFFICER';
  }

  private showScanFlash(entry: DutyLogEntry, time: string): void {
    const member = this.getLogMember(entry);
    this.dismissScanFlash();
    this.scanFlash.set({
      name: member?.name ?? entry.studentName,
      position: member?.position ?? entry.position ?? '',
      typeLabel: memberTypeLabel(member?.member_type),
      photoUrl: member?.photo_url ?? '',
      action: entry.action,
      time,
      totalDutyHours: entry.totalDutyHours
    });
    this.scanFlashTimer = setTimeout(() => this.dismissScanFlash(), SCAN_FLASH_MS);
  }

  private emptyStudent(): NewStudent {
    return { name: '', rfid_uid: '', position: '', member_type: 'OFFICER', photo_url: '' };
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

// Fields that handle their own keys, including selects, whose type-ahead would also react to a scan.
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return true;
  }
  return target instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.includes(target.type);
}
