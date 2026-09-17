import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

export const authGuard: CanActivateFn = (route) => {
  const router = inject(Router);

  if (typeof sessionStorage === 'undefined') {
    return router.parseUrl('/');
  }

  const token = sessionStorage.getItem('itpc-session-token');
  const storedUser = sessionStorage.getItem('itpc-session-user');

  try {
    const user = storedUser ? JSON.parse(storedUser) as { username?: string; role?: string } : null;
    const allowedRoles = route.data['roles'] as string[] | undefined;
    const roleIsAllowed = user?.role && (allowedRoles ?? ['executive', 'committee']).includes(user.role);
    return token && !!roleIsAllowed && !!user.username
      ? true
      : router.parseUrl('/');
  } catch {
    sessionStorage.removeItem('itpc-session-token');
    sessionStorage.removeItem('itpc-session-user');
    return router.parseUrl('/');
  }
};
