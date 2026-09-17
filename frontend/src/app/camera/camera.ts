import {
  Component,
  ElementRef,
  ViewChild,
  ChangeDetectorRef,
  signal
} from '@angular/core';
import * as QRCode from 'qrcode';
import { Router } from '@angular/router';
import { PHOTO_API_BASE_URL } from '../api.config';

type PhotoCount = 2 | 3 | 4;

interface StripLayout {
  id: string;
  name: string;
  photoCount: PhotoCount;
  image: string;
  width: number;
  height: number;
  slots: { x: number; y: number; width: number; height: number; rotation: number }[];
}

@Component({
  selector: 'app-camera',
  standalone: true,
  imports: [],
  templateUrl: './camera.html',
  styleUrl: './camera.scss'
})
export class Camera {

  readonly layouts: StripLayout[] = [
    ...this.createLayouts(2, 1240, 620, [
      { x: 137, y: 52, width: 505, height: 332, rotation: 7 },
      { x: 629, y: 228, width: 505, height: 332, rotation: -4 }
    ]),
    ...this.createLayouts(3, 600, 1800, [
      { x: 32, y: 357, width: 535, height: 312, rotation: 0 },
      { x: 32, y: 697, width: 535, height: 312, rotation: 0 },
      { x: 32, y: 1035, width: 535, height: 312, rotation: 0 }
    ]),
    ...this.createLayouts(4, 600, 1800, [
      { x: 30, y: 193, width: 540, height: 312, rotation: 0 },
      { x: 30, y: 514, width: 540, height: 312, rotation: 0 },
      { x: 30, y: 835, width: 540, height: 312, rotation: 0 },
      { x: 30, y: 1156, width: 540, height: 312, rotation: 0 }
    ])
  ];

  @ViewChild('video')
  video!: ElementRef<HTMLVideoElement>;

  @ViewChild('canvas')
  canvas!: ElementRef<HTMLCanvasElement>;

  @ViewChild('previewCanvas')
  previewCanvas!: ElementRef<HTMLCanvasElement>;

  cameraOpened = signal(false);
  cameraStarting = signal(false);
  cameraError = signal('');
  countdown = signal(0);
  photoData = signal<string[]>([]);
  capturing = signal(false);
  selectedStrip = signal(3);
  selectedLayout = signal('3-itpc');
  boothStep = signal<'capture' | 'layout' | 'finished'>('capture');
  qrCodeData = signal('');
  sharingPhoto = signal(false);
  shareError = signal('');
  readonly stripOptions = [2, 3, 4];
  private mediaStream: MediaStream | null = null;
  private previewLoopId: number | null = null;

  constructor(
    private cdr: ChangeDetectorRef,
    private readonly router: Router
  ) {}

  goBack(): void {
    void this.router.navigateByUrl('/admin');
  }

  selectStrip(photoCount: number): void {
    if (photoCount === 2 || photoCount === 3 || photoCount === 4) {
      this.selectedStrip.set(photoCount);
      this.selectedLayout.set(`${photoCount}-itpc`);
      this.refreshCameraPreview();
    }
  }

  selectLayout(layout: string): void {
    this.selectedLayout.set(layout);
    this.refreshCameraPreview();
  }

  get captureAspectRatio(): number {
    const layout = this.layouts.find(item => item.id === this.selectedLayout())
      ?? this.layouts.find(item => item.photoCount === this.selectedStrip())
      ?? this.layouts[0];

    const slot = layout.slots[0];
    return slot.width / slot.height;
  }

  layoutsForSelectedStrip(): StripLayout[] {
    return this.layouts.filter(layout => layout.photoCount === this.selectedStrip());
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
      this.startPreviewLoop();

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

  private startPreviewLoop(): void {
    if (this.previewLoopId !== null) {
      cancelAnimationFrame(this.previewLoopId);
    }

    const renderFrame = () => {
      if (!this.cameraOpened()) {
        this.previewLoopId = null;
        return;
      }

      this.refreshCameraPreview();
      this.previewLoopId = requestAnimationFrame(renderFrame);
    };

    this.previewLoopId = requestAnimationFrame(renderFrame);
  }

  private refreshCameraPreview(): void {
    if (!this.video || !this.previewCanvas) {
      return;
    }

    const video = this.video.nativeElement;
    const preview = this.previewCanvas.nativeElement;
    if (!video || !preview) {
      return;
    }

    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) {
      return;
    }

    const crop = this.getSelectedCropRect(video);
    preview.width = crop.canvasWidth;
    preview.height = crop.canvasHeight;

    const context = preview.getContext('2d');
    if (!context) {
      return;
    }

    context.clearRect(0, 0, preview.width, preview.height);
    context.save();
    context.translate(preview.width, 0);
    context.scale(-1, 1);
    context.drawImage(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      preview.width,
      preview.height
    );
    context.restore();
  }

  private getSelectedCropRect(video: HTMLVideoElement): {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
  } {
    const selectedLayout = this.layouts.find(item => item.id === this.selectedLayout())
      ?? this.layouts.find(item => item.photoCount === this.selectedStrip())
      ?? this.layouts[0];
    const slot = selectedLayout.slots[0];
    const targetAspectRatio = slot.width / slot.height;
    const sourceAspectRatio = video.videoWidth / video.videoHeight;
    const cropScale = 1.6;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;

    if (sourceAspectRatio > targetAspectRatio) {
      sourceHeight = video.videoHeight;
      sourceWidth = sourceHeight * targetAspectRatio;
    } else {
      sourceWidth = video.videoWidth;
      sourceHeight = sourceWidth / targetAspectRatio;
    }

    sourceWidth /= cropScale;
    sourceHeight /= cropScale;
    const sourceX = (video.videoWidth - sourceWidth) / 2;
    const sourceY = (video.videoHeight - sourceHeight) / 2;
    const canvasWidth = 1600;
    const canvasHeight = Math.round(canvasWidth / targetAspectRatio);

    return {
      x: sourceX,
      y: sourceY,
      width: sourceWidth,
      height: sourceHeight,
      canvasWidth,
      canvasHeight
    };
  }

  private capturePhoto(): string | null {

    const video = this.video.nativeElement;
    const canvas = this.canvas.nativeElement;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      console.error('Camera is not ready');
      return null;
    }

    const crop = this.getSelectedCropRect(video);
    canvas.width = crop.canvasWidth;
    canvas.height = crop.canvasHeight;

    const context = canvas.getContext('2d');

    if (!context) {
      return null;
    }

    context.save();
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(
      video,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
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
    this.cameraStarting.set(false);
    this.cameraError.set('');
    this.countdown.set(0);
    this.cdr.detectChanges();
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
    const layout = this.layouts.find(item => item.id === this.selectedLayout());
    if (!layout) {
      throw new Error('Photo strip layout is unavailable');
    }

    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is unavailable');
    }

    const photos = await Promise.all(this.photoData().slice(0, layout.photoCount).map(photo => this.loadImage(photo)));

    photos.forEach((photo, index) => {
      const slot = layout.slots[index];
      const photoAspectRatio = photo.width / photo.height;
      const slotAspectRatio = slot.width / slot.height;
      const coverScale = 2.2;
      let drawWidth = slot.width * coverScale;
      let drawHeight = slot.height * coverScale;

      if (photoAspectRatio > slotAspectRatio) {
        drawHeight = slot.height * coverScale;
        drawWidth = drawHeight * photoAspectRatio;
      } else {
        drawWidth = slot.width * coverScale;
        drawHeight = drawWidth / photoAspectRatio;
      }

      context.save();
      context.translate(slot.x + slot.width / 2, slot.y + slot.height / 2);
      context.rotate(slot.rotation * Math.PI / 180);
      context.drawImage(photo, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      context.restore();
    });

    const template = await this.loadImage(layout.image);
    context.drawImage(template, 0, 0, canvas.width, canvas.height);

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
    if (this.previewLoopId !== null) {
      cancelAnimationFrame(this.previewLoopId);
      this.previewLoopId = null;
    }
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

  private createLayouts(
    photoCount: PhotoCount,
    width: number,
    height: number,
    slots: StripLayout['slots']
  ): StripLayout[] {
    return [
      ['comicstrip', 'Comic Strip'],
      ['itpcstrip', 'ITPC Strip'],
      ['redstrip', 'Red Strip']
    ].map(([style, name]) => ({
      id: `${photoCount}-${style.replace('strip', '')}`,
      name,
      photoCount,
      image: `assets/fv ${photoCount}-${style}.png`,
      width,
      height,
      slots
    }));
  }
}