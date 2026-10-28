import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { DutyLogTable } from './duty-log-table';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [DutyLogTable],
  templateUrl: './admin.html',
  styleUrl: './admin.scss'
})
export class Admin {
  readonly username: string;
  readonly role: 'executive';
  readonly roleLabel: string;
  readonly canUsePhotobooth: boolean;

  constructor(private readonly router: Router) {
    if (typeof sessionStorage === 'undefined') {
      this.username = '';
      this.role = 'executive';
      this.roleLabel = 'Executive Board';
      this.canUsePhotobooth = false;
      return;
    }

    const storedUser = sessionStorage.getItem('itpc-session-user');
    const token = sessionStorage.getItem('itpc-session-token');

    try {
      const user = storedUser ? JSON.parse(storedUser) as { username?: string; role?: string } : null;
      if (!token || !user?.username || user.role !== 'executive') {
        void this.router.navigateByUrl('/');
        this.username = '';
        this.role = 'executive';
        this.roleLabel = 'Executive Board';
        this.canUsePhotobooth = false;
        return;
      }
      this.username = user.username;
      this.role = 'executive';
      this.roleLabel = 'Executive Board';
      this.canUsePhotobooth = true;
    } catch {
      void this.router.navigateByUrl('/');
      this.username = '';
      this.role = 'executive';
      this.roleLabel = 'Executive Board';
      this.canUsePhotobooth = false;
    }
  }

  logout(): void {
    sessionStorage.removeItem('itpc-session-token');
    sessionStorage.removeItem('itpc-session-user');
    window.location.assign('/');
  }

  openPhotobooth(): void {
    void this.router.navigateByUrl('/photobooth');
  }

  openDutyHours(): void {
    void this.router.navigateByUrl('/admin/duty-hours');
  }

  goHome(): void {
    void this.router.navigateByUrl('/');
  }
}
