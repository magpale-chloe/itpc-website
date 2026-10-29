import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import {
  DutyLogEntry,
  DutyLogService,
  MEMBER_TYPE_OPTIONS,
  MemberType,
  REQUIRED_WEEKLY_HOURS,
  StudentRecord,
  hasWeeklyRequirement,
  memberInitials,
  memberTypeLabel
} from '../duty-log.service';

type TypeFilter = 'REQUIRED' | 'ALL' | MemberType;
type SortOrder = 'NEEDS_HOURS' | 'MOST_HOURS' | 'NAME';

interface MemberWeek {
  student: StudentRecord;
  hours: number;
  sessions: number;
  onDuty: boolean;
  required: number;
  remaining: number;
  progress: number;
  met: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Component({
  selector: 'app-duty-hours',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './duty-hours.html',
  styleUrl: './duty-hours.scss',
  host: { '(document:keydown.escape)': 'closeDetails()' }
})
export class DutyHours implements OnInit {
  private readonly dutyLogService = inject(DutyLogService);
  private readonly router = inject(Router);

  readonly memberTypeOptions = MEMBER_TYPE_OPTIONS;
  readonly memberInitials = memberInitials;
  readonly memberTypeLabel = memberTypeLabel;
  readonly requiredHours = REQUIRED_WEEKLY_HOURS;

  readonly students = signal<StudentRecord[]>([]);
  readonly logs = signal<DutyLogEntry[]>([]);
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly weekOffset = signal(0);
  readonly typeFilter = signal<TypeFilter>('REQUIRED');
  readonly search = signal('');
  readonly sortOrder = signal<SortOrder>('NEEDS_HOURS');
  readonly selectedStudentId = signal<string | null>(null);
  readonly editingLogId = signal<string | null>(null);
  readonly editClockIn = signal('');
  readonly editClockOut = signal('');
  readonly savingLog = signal(false);
  readonly editError = signal('');
  readonly maxInputTime = signal(toLocalInput(new Date().toISOString()));

  readonly selectedWeek = computed(() =>
    this.memberWeeks().find((week) => week.student.id === this.selectedStudentId()) ?? null
  );
  readonly selectedLogs = computed(() =>
    this.logs()
      .filter((log) => !log.isNonMember && log.studentId === this.selectedStudentId())
      .sort((left, right) => (right.clockInTime ?? '').localeCompare(left.clockInTime ?? ''))
  );

  readonly weekStart = computed(() => {
    const start = startOfWeek(new Date());
    start.setDate(start.getDate() + this.weekOffset() * 7);
    return start;
  });
  readonly weekEnd = computed(() => {
    const end = new Date(this.weekStart());
    end.setDate(end.getDate() + 7);
    return end;
  });
  readonly weekLabel = computed(() => {
    const lastDay = new Date(this.weekEnd().getTime() - DAY_MS);
    const format: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    return `${this.weekStart().toLocaleDateString(undefined, format)} – ${lastDay.toLocaleDateString(undefined, { ...format, year: 'numeric' })}`;
  });

  readonly memberWeeks = computed<MemberWeek[]>(() => {
    const totals = new Map<string, { hours: number; sessions: number; onDuty: boolean }>();
    for (const log of this.logs()) {
      if (log.isNonMember || !log.studentId) {
        continue;
      }
      const total = totals.get(log.studentId) ?? { hours: 0, sessions: 0, onDuty: false };
      if (log.status === 'ACTIVE') {
        total.onDuty = true;
      } else {
        total.hours += log.totalDutyHours ?? 0;
        total.sessions += 1;
      }
      totals.set(log.studentId, total);
    }

    return this.students().map((student) => {
      const total = totals.get(student.id) ?? { hours: 0, sessions: 0, onDuty: false };
      const hours = Number(total.hours.toFixed(2));
      const required = hasWeeklyRequirement(student) ? REQUIRED_WEEKLY_HOURS : 0;
      return {
        student,
        hours,
        sessions: total.sessions,
        onDuty: total.onDuty,
        required,
        remaining: Number(Math.max(required - hours, 0).toFixed(2)),
        progress: required ? Math.min(hours / required, 1) * 100 : 0,
        met: hours >= required
      };
    });
  });

  readonly visibleWeeks = computed(() => {
    const filter = this.typeFilter();
    const search = this.search().trim().toLowerCase();
    const sort = this.sortOrder();
    return this.memberWeeks()
      .filter((week) => filter === 'ALL'
        || (filter === 'REQUIRED' ? week.required > 0 : week.student.member_type === filter))
      .filter((week) => !search || [week.student.name, week.student.position]
        .some((value) => value.toLowerCase().includes(search)))
      .sort((left, right) => {
        if (sort === 'MOST_HOURS') {
          return right.hours - left.hours || left.student.name.localeCompare(right.student.name);
        }
        if (sort === 'NEEDS_HOURS') {
          return right.remaining - left.remaining
            || right.required - left.required
            || left.student.name.localeCompare(right.student.name);
        }
        return left.student.name.localeCompare(right.student.name);
      });
  });

  readonly summary = computed(() => {
    const required = this.memberWeeks().filter((week) => week.required > 0);
    return {
      requiredCount: required.length,
      metCount: required.filter((week) => week.met).length,
      behindCount: required.filter((week) => !week.met).length,
      totalHours: Number(this.memberWeeks().reduce((sum, week) => sum + week.hours, 0).toFixed(2))
    };
  });

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.errorMessage.set('');
    forkJoin({
      students: this.dutyLogService.getStudents(),
      logs: this.dutyLogService.getLogsBetween(this.weekStart(), this.weekEnd())
    }).subscribe({
      next: ({ students, logs }) => {
        this.students.set(students);
        this.logs.set(logs);
        this.loading.set(false);
      },
      error: () => {
        this.errorMessage.set('Unable to load duty hours for this week right now.');
        this.loading.set(false);
      }
    });
  }

  changeWeek(delta: number): void {
    this.weekOffset.update((offset) => offset + delta);
    this.load();
  }

  goToCurrentWeek(): void {
    this.weekOffset.set(0);
    this.load();
  }

  goBack(): void {
    void this.router.navigateByUrl('/admin');
  }

  openDetails(studentId: string): void {
    this.selectedStudentId.set(studentId);
    this.cancelEdit();
  }

  closeDetails(): void {
    if (this.savingLog()) {
      return;
    }
    this.selectedStudentId.set(null);
    this.cancelEdit();
  }

  startEdit(log: DutyLogEntry): void {
    if (!log.id || !log.clockInTime) {
      return;
    }
    this.editingLogId.set(log.id);
    this.editClockIn.set(toLocalInput(log.clockInTime));
    this.editClockOut.set(log.clockOutTime ? toLocalInput(log.clockOutTime) : '');
    this.maxInputTime.set(toLocalInput(new Date().toISOString()));
    this.editError.set('');
  }

  cancelEdit(): void {
    this.editingLogId.set(null);
    this.editError.set('');
  }

  saveEdit(log: DutyLogEntry): void {
    if (!log.id || this.savingLog()) {
      return;
    }
    const clockIn = new Date(this.editClockIn());
    const clockOut = this.editClockOut() ? new Date(this.editClockOut()) : null;
    if (Number.isNaN(clockIn.getTime()) || (clockOut && Number.isNaN(clockOut.getTime()))) {
      this.editError.set('Enter a valid date and time.');
      return;
    }
    if (log.status === 'COMPLETED' && !clockOut) {
      this.editError.set('A completed session needs a clock-out time.');
      return;
    }
    if (clockOut && clockOut <= clockIn) {
      this.editError.set('Clock-out must be after clock-in.');
      return;
    }

    this.savingLog.set(true);
    this.editError.set('');
    this.dutyLogService.updateLogTimes(log.id, clockIn.toISOString(), clockOut?.toISOString() ?? null).subscribe({
      next: (updated) => {
        // A log moved outside the viewed week drops out of this week's totals.
        const updatedClockIn = new Date(updated.clockInTime ?? '').getTime();
        const inWeek = updatedClockIn >= this.weekStart().getTime() && updatedClockIn < this.weekEnd().getTime();
        this.logs.update((logs) => inWeek
          ? logs.map((entry) => entry.id === updated.id ? updated : entry)
          : logs.filter((entry) => entry.id !== updated.id));
        this.savingLog.set(false);
        this.editingLogId.set(null);
      },
      error: (error: { error?: { error?: string } }) => {
        this.editError.set(error.error?.error ?? 'Unable to save this session right now.');
        this.savingLog.set(false);
      }
    });
  }

  formatDay(iso: string | undefined): string {
    return iso ? new Date(iso).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  }

  formatTime(iso: string | undefined): string {
    return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '—';
  }
}

// Converts an ISO timestamp to the local "YYYY-MM-DDTHH:mm" value a datetime-local input expects.
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Duty weeks run Monday 00:00 to the next Monday 00:00 in local time.
function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}
