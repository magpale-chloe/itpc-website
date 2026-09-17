import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { resolvePhotoApiBaseUrl } from './api.config';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should use the local backend when running on localhost', () => {
    expect(resolvePhotoApiBaseUrl('localhost')).toBe('http://localhost:3000');
    expect(resolvePhotoApiBaseUrl('127.0.0.1')).toBe('http://localhost:3000');
  });

  it('should use the hosted backend outside local development', () => {
    expect(resolvePhotoApiBaseUrl('itpc-photobooth.onrender.com')).toBe('https://itpc-photobooth.onrender.com');
  });
});
