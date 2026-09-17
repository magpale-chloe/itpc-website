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
		data: { roles: ['executive', 'committee'] },
		loadComponent: () => import('./admin/admin').then(({ Admin }) => Admin)
	},
	{
		path: 'photobooth',
		canActivate: [authGuard],
		data: { roles: ['executive'] },
		loadComponent: () => import('./camera/camera').then(({ Camera }) => Camera)
	}
];
