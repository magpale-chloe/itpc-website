import { Routes } from '@angular/router';
import { App } from './app';
import { authGuard } from './auth.guard';

export const routes: Routes = [
	{
		path: '',
		component: App
	},
	{
		path: 'admin',
		canActivate: [authGuard],
		data: { roles: ['executive'] },
		loadComponent: () => import('./admin/admin').then(({ Admin }) => Admin)
	},
	{
		path: 'admin/duty-hours',
		canActivate: [authGuard],
		data: { roles: ['executive'] },
		loadComponent: () => import('./admin/duty-hours').then(({ DutyHours }) => DutyHours)
	},
	{
		path: 'photobooth',
		canActivate: [authGuard],
		data: { roles: ['executive'] },
		loadComponent: () => import('./camera/camera').then(({ Camera }) => Camera)
	}
];
