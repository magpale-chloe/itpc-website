import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

// A 401 on a request that carried our session token means the login expired: clear it and return to sign-in.
export const sessionExpiredInterceptor: HttpInterceptorFn = (request, next) =>
  next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        request.headers.get('Authorization')?.startsWith('Bearer ') &&
        typeof sessionStorage !== 'undefined'
      ) {
        sessionStorage.removeItem('itpc-session-token');
        sessionStorage.removeItem('itpc-session-user');
        window.alert('Your session has expired. Please log in again.');
        window.location.assign('/');
      }
      return throwError(() => error);
    })
  );
