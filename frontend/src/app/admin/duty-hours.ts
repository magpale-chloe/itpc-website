import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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
  formatDuration,
  hasWeeklyRequirement,
  memberBadgeLabel,
  memberBadgeTone,
  memberInitials,
  memberTypeLabel,
  sessionMinutes
} from '../duty-log.service';

type TypeFilter = 'REQUIRED' | 'ALL' | MemberType;
type SortOrder = 'NEEDS_HOURS' | 'MOST_HOURS' | 'NAME';

interface MemberWeek {
  student: StudentRecord;
  minutes: number;
  sessions: number;
  onDuty: boolean;
  // Required hours this week; 0 when the member type has no requirement.
  required: number;
  remainingMinutes: number;
  progress: number;
  met: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_SESSION_ID = 'new-session';

@Component({
  selector: 'app-duty-hours',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
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
  readonly memberBadgeLabel = memberBadgeLabel;
  readonly memberBadgeTone = memberBadgeTone;
  readonly formatDuration = formatDuration;
  readonly sessionMinutes = sessionMinutes;
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
  readonly editNotice = signal('');
  readonly newSessionId = NEW_SESSION_ID;
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
    const totals = new Map<string, { minutes: number; sessions: number; onDuty: boolean }>();
    for (const log of this.logs()) {
      if (log.isNonMember || !log.studentId) {
        continue;
      }
      const total = totals.get(log.studentId) ?? { minutes: 0, sessions: 0, onDuty: false };
      if (log.status === 'ACTIVE') {
        total.onDuty = true;
      } else {
        total.minutes += sessionMinutes(log);
        total.sessions += 1;
      }
      totals.set(log.studentId, total);
    }

    return this.students().map((student) => {
      const total = totals.get(student.id) ?? { minutes: 0, sessions: 0, onDuty: false };
      const required = hasWeeklyRequirement(student) ? REQUIRED_WEEKLY_HOURS : 0;
      const requiredMinutes = required * 60;
      return {
        student,
        minutes: total.minutes,
        sessions: total.sessions,
        onDuty: total.onDuty,
        required,
        remainingMinutes: Math.max(requiredMinutes - total.minutes, 0),
        progress: requiredMinutes ? Math.min(total.minutes / requiredMinutes, 1) * 100 : 0,
        met: total.minutes >= requiredMinutes
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
          return right.minutes - left.minutes || left.student.name.localeCompare(right.student.name);
        }
        if (sort === 'NEEDS_HOURS') {
          return right.remainingMinutes - left.remainingMinutes
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
      totalMinutes: this.memberWeeks().reduce((sum, week) => sum + week.minutes, 0)
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
    this.editNotice.set('');
  }

  // New sessions default to 8–9 AM yesterday, or to the first day of a past week being viewed.
  startAdd(): void {
    const day = this.weekOffset() === 0 ? new Date(Date.now() - DAY_MS) : new Date(this.weekStart());
    day.setHours(8, 0, 0, 0);
    this.editingLogId.set(NEW_SESSION_ID);
    this.editClockIn.set(toLocalInput(day.toISOString()));
    this.editClockOut.set(toLocalInput(new Date(day.getTime() + 60 * 60 * 1000).toISOString()));
    this.maxInputTime.set(toLocalInput(new Date().toISOString()));
    this.editError.set('');
    this.editNotice.set('');
  }

  // Saves the open form: a new session when log is null, otherwise an edit of that log.
  saveEdit(log: DutyLogEntry | null): void {
    const studentId = this.selectedStudentId();
    if ((log ? !log.id : !studentId) || this.savingLog()) {
      return;
    }
    const clockIn = new Date(this.editClockIn());
    const clockOut = this.editClockOut() ? new Date(this.editClockOut()) : null;
    if (Number.isNaN(clockIn.getTime()) || (clockOut && Number.isNaN(clockOut.getTime()))) {
      this.editError.set('Enter a valid date and time.');
      return;
    }
    if ((!log || log.status === 'COMPLETED') && !clockOut) {
      this.editError.set('A completed session needs a clock-out time.');
      return;
    }
    if (clockOut && clockOut <= clockIn) {
      this.editError.set('Clock-out must be after clock-in.');
      return;
    }

    this.savingLog.set(true);
    this.editError.set('');
    this.editNotice.set('');
    const request = log?.id
      ? this.dutyLogService.updateLogTimes(log.id, clockIn.toISOString(), clockOut?.toISOString() ?? null)
      : this.dutyLogService.createCompletedLog(studentId!, clockIn.toISOString(), clockOut!.toISOString());
    request.subscribe({
      next: (saved) => {
        // A session outside the viewed week drops out of this week's totals.
        const savedClockIn = new Date(saved.clockInTime ?? '').getTime();
        const inWeek = savedClockIn >= this.weekStart().getTime() && savedClockIn < this.weekEnd().getTime();
        this.logs.update((logs) => [
          ...logs.filter((entry) => entry.id !== saved.id),
          ...(inWeek ? [saved] : [])
        ]);
        if (!inWeek) {
          this.editNotice.set(`Saved for ${this.formatDay(saved.clockInTime)}. That date is in a different week, so switch weeks to see it.`);
        }
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
