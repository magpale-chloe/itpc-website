import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { signal } from '@angular/core';
import { Admin } from './admin/admin';
import { Camera } from './camera/camera';
import { DutyHours } from './admin/duty-hours';
import { PHOTO_API_BASE_URL } from './api.config';

interface Highlight {
  number: string;
  title: string;
  description: string;
  tag: string;
}

type LoginRole = 'executive' | 'committee';

interface AuthUser {
  username: string;
  role: LoginRole;
}

// Committee accounts are view-only and land on the duty hours page instead of the workspace.
function homePageFor(role: LoginRole): string {
  return role === 'committee' ? '/admin/duty-hours' : '/admin';
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, Admin, Camera, DutyHours],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  readonly authApiUrl = `${PHOTO_API_BASE_URL}/api/auth`;

  loginOpen = false;
  loginRole: LoginRole = 'executive';
  username = '';
  password = '';
  loginError = '';
  loginPending = false;
  currentUser: AuthUser | null = this.restoreSession();
  readonly adminPage = signal(false);
  readonly photoboothPage = signal(false);
  readonly dutyHoursPage = signal(false);

  constructor(private readonly router: Router) {
    this.adminPage.set(this.router.url === '/admin');
    this.photoboothPage.set(this.router.url === '/photobooth');
    this.dutyHoursPage.set(this.router.url === '/admin/duty-hours');
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.adminPage.set(event.urlAfterRedirects === '/admin');
        this.photoboothPage.set(event.urlAfterRedirects === '/photobooth');
        this.dutyHoursPage.set(event.urlAfterRedirects === '/admin/duty-hours');
      });
  }

  isAdminPage(): boolean {
    return this.adminPage();
  }

  isDutyHoursPage(): boolean {
    return this.dutyHoursPage();
  }

  isPhotoboothPage(): boolean {
    return this.photoboothPage();
  }

  openAdmin(): void {
    if (this.currentUser) {
      void this.router.navigateByUrl(homePageFor(this.currentUser.role));
    }
  }

  setLoginRole(role: LoginRole): void {
    this.loginRole = role;
    this.loginError = '';
  }

  readonly highlights: Highlight[] = [
    {
      number: '01',
      title: 'Student Leadership',
      description: 'Creating opportunities for students to lead projects, manage events, and develop professional organizational skills.',
      tag: 'Lorem ipsum'
    },
    {
      number: '02',
      title: 'Tech Innovation',
      description: 'Encouraging continuous learning through technical seminars, hands-on workshops, and collaborative programming projects.',
      tag: 'Lorem ipsum'
    },
    {
      number: '03',
      title: 'Community Building',
      description: 'Building a supportive network of future tech professionals who share resources, ideas, and a passion for IT.',
      tag: 'Lorem ipsum'
    }
  ];

  openLogin(): void {
    this.loginOpen = true;
    this.loginError = '';
  }

  closeLogin(): void {
    if (!this.loginPending) {
      this.loginOpen = false;
      this.loginError = '';
    }
  }

  async login(): Promise<void> {
    if (!this.username.trim() || !this.password || this.loginPending) {
      this.loginError = 'Enter your username and password.';
      return;
    }

    this.loginPending = true;
    this.loginError = '';

    try {
      const response = await fetch(`${this.authApiUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: this.username.trim(),
          password: this.password,
          role: this.loginRole
        })
      });

      const result = await response.json() as { token?: string; user?: AuthUser; error?: string };
      if (!response.ok || !result.token || !result.user) {
        throw new Error(result.error || 'Login failed.');
      }

      sessionStorage.setItem('itpc-session-token', result.token);
      sessionStorage.setItem('itpc-session-user', JSON.stringify(result.user));
      this.currentUser = result.user;
      this.password = '';
      this.loginOpen = false;
      const pageOpened = await this.router.navigateByUrl(homePageFor(result.user.role));
      if (!pageOpened) {
        throw new Error('The workspace page could not be opened.');
      }
    } catch (error) {
      this.loginError = error instanceof TypeError
        ? 'The login service is unavailable right now.'
        : error instanceof Error ? error.message : 'Login failed.';
    } finally {
      this.loginPending = false;
    }
  }

  logout(): void {
    const token = sessionStorage.getItem('itpc-session-token');
    if (token) {
      void fetch(`${this.authApiUrl}/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
    }
    sessionStorage.removeItem('itpc-session-token');
    sessionStorage.removeItem('itpc-session-user');
    this.currentUser = null;
  }

  private restoreSession(): AuthUser | null {
    if (typeof sessionStorage === 'undefined') {
      return null;
    }

    const token = sessionStorage.getItem('itpc-session-token');
    const storedUser = sessionStorage.getItem('itpc-session-user');
    if (!token || !storedUser) {
      return null;
    }

    try {
      const user = JSON.parse(storedUser) as { username?: unknown; role?: unknown };
      if (typeof user.username !== 'string' || (user.role !== 'executive' && user.role !== 'committee')) {
        sessionStorage.removeItem('itpc-session-token');
        sessionStorage.removeItem('itpc-session-user');
        return null;
      }
      return { username: user.username, role: user.role };
    } catch {
      sessionStorage.removeItem('itpc-session-token');
      sessionStorage.removeItem('itpc-session-user');
      return null;
    }
  }

  readonly socialLinks = [
    { label: 'Facebook', detail: 'Follow our updates', href: 'https://www.facebook.com/DLSUD.ITPC' },
    { label: 'Instagram', detail: 'See our latest moments', href: 'https://www.instagram.com/dlsud.itpc/' },
    { label: 'Outlook email', detail: 'itpc@dlsud.edu.ph', href: 'mailto:itpc@dlsud.edu.ph' }
  ];
}