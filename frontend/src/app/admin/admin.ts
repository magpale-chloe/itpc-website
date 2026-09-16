import { Component } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-admin',
  standalone: true,
  templateUrl: './admin.html',
  styleUrl: './admin.scss'
})
export class Admin {
  readonly username: string;

  constructor(private readonly router: Router) {
    if (typeof sessionStorage === 'undefined') {
      this.username = '';
      return;
    }

    const storedUser = sessionStorage.getItem('itpc-session-user');
    const token = sessionStorage.getItem('itpc-session-token');

    try {
      const user = storedUser ? JSON.parse(storedUser) as { username?: string; role?: string } : null;
      if (!token || user?.role !== 'executive' || !user.username) {
        void this.router.navigateByUrl('/');
        this.username = '';
        return;
      }
      this.username = user.username;
    } catch {
      void this.router.navigateByUrl('/');
      this.username = '';
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

  goHome(): void {
    void this.router.navigateByUrl('/');
  }
}
