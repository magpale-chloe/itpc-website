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
  styleUrl: './duty-hours.scss'
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
}

// Duty weeks run Monday 00:00 to the next Monday 00:00 in local time.
function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}
