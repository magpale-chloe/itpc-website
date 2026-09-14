import {
  Component,
  ElementRef,
  ViewChild,
  ChangeDetectorRef,
  signal
} from '@angular/core';
import * as QRCode from 'qrcode';
import { PHOTO_API_BASE_URL } from '../api.config';

@Component({
  selector: 'app-camera',
  standalone: true,
  imports: [],
  templateUrl: './camera.html',
  styleUrl: './camera.scss'
})
export class Camera {

  private readonly photoAspectRatio = 480 / 394;

  readonly layouts = [
    { id: 'light', name: 'ITPC Light', image: '/assets/3-light.png' },
    { id: 'dark', name: 'ITPC Dark', image: '/assets/3-dark.png' }
  ] as const;

  @ViewChild('video')
  video!: ElementRef<HTMLVideoElement>;

  @ViewChild('canvas')
  canvas!: ElementRef<HTMLCanvasElement>;

  cameraOpened = signal(false);
  cameraStarting = signal(false);
  cameraError = signal('');
  countdown = signal(0);
  photoData = signal<string[]>([]);
  capturing = signal(false);
  selectedStrip = signal(3);
  selectedLayout = signal<'light' | 'dark'>('light');
  boothStep = signal<'capture' | 'layout' | 'finished'>('capture');
  qrCodeData = signal('');
  sharingPhoto = signal(false);
  shareError = signal('');
  readonly stripOptions = [2, 3, 4];
  private mediaStream: MediaStream | null = null;

  constructor(private cdr: ChangeDetectorRef) {}

  selectStrip(photoCount: number): void {
    this.selectedStrip.set(photoCount);
  }

  selectLayout(layout: 'light' | 'dark'): void {
    this.selectedLayout.set(layout);
  }

  async openCamera(): Promise<void> {

    if (this.cameraStarting() || this.cameraOpened()) {
      return;
    }

    console.log('Opening camera...');
    this.cameraStarting.set(true);
    this.cameraError.set('');

    let stream: MediaStream | null = null;

    try {

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera API is unavailable');
      }

      const cameraRequest = navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false
      });

      const timeout = new Promise<MediaStream>((_, reject) => {
        setTimeout(() => reject(new Error('Camera permission request timed out')), 8000);
      });

      stream = await Promise.race([cameraRequest, timeout]);
      this.mediaStream = stream;

      const video = this.video.nativeElement;
      video.srcObject = stream;
      video.muted = true;

      this.cameraOpened.set(true);
      this.cameraStarting.set(false);
      this.cdr.detectChanges();

      video.play().catch(error => {
        console.warn('Video autoplay was blocked:', error);
      });

      console.log('Camera opened');

    } catch (error) {

      console.error('Camera error:', error);
      stream?.getTracks().forEach(track => track.stop());
      this.cameraError.set('Camera access was not available. Check browser permissions and try again.');

    } finally {

      this.cameraStarting.set(false);
      this.cdr.detectChanges();

    }
  }

  async takePhoto(): Promise<void> {

    if (!this.cameraOpened() || this.countdown() > 0 || this.capturing()) {
      return;
    }

    this.capturing.set(true);
    this.photoData.set([]);

    try {
      await this.waitForVideoReady(this.video.nativeElement);

      const photoCount = this.selectedStrip();
      console.log(`Capturing ${photoCount} photos`);

      for (let photoIndex = 0; photoIndex < photoCount; photoIndex++) {
        for (let remaining = photoCount; remaining > 0; remaining--) {
          this.countdown.set(remaining);
          this.cdr.detectChanges();
          await this.wait(1000);
        }

        this.countdown.set(0);
        const capturedPhoto = this.capturePhoto();

        if (capturedPhoto) {
          this.photoData.update(photos => [...photos, capturedPhoto]);
        }

        if (photoIndex < photoCount - 1) {
          await this.wait(400);
        }
      }

    } catch (error) {

      console.error('Camera is not ready:', error);
      this.cameraError.set('The camera video is not ready yet. Please try again.');

    } finally {

      this.countdown.set(0);
      this.capturing.set(false);
      this.cdr.detectChanges();
    }
  }

  private capturePhoto(): string | null {

    const video = this.video.nativeElement;
    const canvas = this.canvas.nativeElement;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      console.error('Camera is not ready');
      return null;
    }

    const sourceAspectRatio = video.videoWidth / video.videoHeight;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    let sourceX = 0;
    let sourceY = 0;

    if (sourceAspectRatio > this.photoAspectRatio) {
      sourceWidth = video.videoHeight * this.photoAspectRatio;
      sourceX = (video.videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = video.videoWidth / this.photoAspectRatio;
      sourceY = (video.videoHeight - sourceHeight) / 2;
    }

    canvas.width = video.videoWidth;
    canvas.height = Math.round(canvas.width / this.photoAspectRatio);

    const context = canvas.getContext('2d');

    if (!context) {
      return null;
    }

    context.save();
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(
      video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );
    context.restore();

    console.log('Photo captured');
    return canvas.toDataURL('image/png');
  }

  retakePhoto(): void {
    this.stopCamera();
    this.photoData.set([]);
    this.boothStep.set('capture');
    this.cameraOpened.set(false);
    this.cdr.detectChanges();

    setTimeout(() => void this.openCamera());
  }

  continuePhoto(): void {
    if (this.photoData().length !== this.selectedStrip()) {
      return;
    }

    this.boothStep.set('layout');
  }

  async useLayout(): Promise<void> {
    this.boothStep.set('finished');
    this.qrCodeData.set('');
    this.shareError.set('');
    this.sharingPhoto.set(true);

    try {
      const image = await this.renderPhotoStrip();
      const response = await fetch(this.getPhotoApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image })
      });

      if (!response.ok) {
        throw new Error('Photo upload failed');
      }

      const { url } = await response.json() as { url: string };
      this.qrCodeData.set(await QRCode.toDataURL(url, {
        width: 280,
        margin: 2,
        color: { dark: '#063248', light: '#ffffff' }
      }));
    } catch (error) {
      console.error('Could not create photo QR code:', error);
      this.shareError.set('The QR code could not be created. You can still download the strip below.');
    } finally {
      this.sharingPhoto.set(false);
    }
  }

  async downloadPhotoStrip(): Promise<void> {
    const image = await this.renderPhotoStrip();

    const link = document.createElement('a');
    link.download = `itpc-photobooth-${this.selectedLayout()}.png`;
    link.href = image;
    link.click();
  }

  private async renderPhotoStrip(): Promise<string> {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 1800;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is unavailable');
    }

    const template = await this.loadImage(this.layouts.find(layout => layout.id === this.selectedLayout())!.image);
    context.drawImage(template, 0, 0, canvas.width, canvas.height);

    const slot = { x: 60, width: 480, height: 394 };
    const slotTops = [432, 842, 1253];
    const photos = await Promise.all(this.photoData().slice(0, 3).map(photo => this.loadImage(photo)));

    photos.forEach((photo, index) => {
      context.drawImage(photo, slot.x, slotTops[index], slot.width, slot.height);
    });

    return canvas.toDataURL('image/png');
  }

  private getPhotoApiUrl(): string {
    const baseUrl = PHOTO_API_BASE_URL || `${window.location.protocol}//${window.location.hostname}:3000`;
    return `${baseUrl.replace(/\/$/, '')}/api/photos`;
  }

  private loadImage(source: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
  }

  private stopCamera(): void {
    this.mediaStream?.getTracks().forEach(track => track.stop());
    this.mediaStream = null;
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      setTimeout(resolve, milliseconds);
    });
  }

  private async waitForVideoReady(video: HTMLVideoElement): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (video.videoWidth > 0 && video.videoHeight > 0) {
        return;
      }

      await this.wait(100);
    }

    throw new Error('Video stream did not become ready');
  }
}