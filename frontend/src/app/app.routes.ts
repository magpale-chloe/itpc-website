import { Routes } from '@angular/router';
import { App } from './app';

export const routes: Routes = [
	{
		path: '',
		component: App
	},
	{
		path: 'admin',
		loadComponent: () => import('./admin/admin').then(({ Admin }) => Admin)
	},
	{
		path: 'photobooth',
		loadComponent: () => import('./camera/camera').then(({ Camera }) => Camera)
	}
];
