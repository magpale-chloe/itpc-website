import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Camera } from './camera';

describe('Camera', () => {
  let component: Camera;
  let fixture: ComponentFixture<Camera>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Camera],
    }).compileComponents();

    fixture = TestBed.createComponent(Camera);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('uses a 10 second countdown before each capture', async () => {
    const waitSpy = vi.spyOn(component as any, 'wait').mockResolvedValue(undefined);
    const captureSpy = vi.spyOn(component as any, 'capturePhoto').mockReturnValue('captured');

    component.cameraOpened.set(true);
    component.selectedStrip.set(2);
    component.countdown.set(0);

    vi.spyOn(component as any, 'waitForVideoReady').mockResolvedValue(undefined);

    await component.takePhoto();

    expect(waitSpy.mock.calls.filter(([ms]) => ms === 1000)).toHaveLength(20);
    expect(component.countdown()).toBe(0);
    expect(captureSpy).toHaveBeenCalledTimes(2);
  });

  it('moves to layout selection after capturing the selected number of photos', () => {
    component.photoData.set(['one', 'two', 'three']);

    component.continuePhoto();

    expect(component.boothStep()).toBe('layout');
  });

  it('keeps the selected layout when the user changes it', () => {
    component.selectLayout('3-itpc');

    expect(component.selectedLayout()).toBe('3-itpc');
  });

  it('draws the template before the captured photos so the strip shows the photos', async () => {
    const templateImage = { width: 600, height: 1800, src: 'assets/fv 3-itpcstrip.png' } as HTMLImageElement;
    const photoOne = { width: 200, height: 200, src: 'one' } as HTMLImageElement;
    const photoTwo = { width: 200, height: 200, src: 'two' } as HTMLImageElement;
    const photoThree = { width: 200, height: 200, src: 'three' } as HTMLImageElement;
    const drawOrder: string[] = [];

    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn((image: HTMLImageElement) => {
        drawOrder.push(image.src);
      }),
    };

    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => context,
          toDataURL: () => 'data:image/png;base64,strip',
        } as unknown as HTMLCanvasElement;
      }

      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    vi.spyOn(component as any, 'loadImage').mockImplementation((source: any) => {
      const sourceValue = String(source);

      if (sourceValue === 'assets/fv 3-itpcstrip.png') {
        return Promise.resolve(templateImage);
      }

      if (sourceValue === 'one') {
        return Promise.resolve(photoOne);
      }

      if (sourceValue === 'two') {
        return Promise.resolve(photoTwo);
      }

      if (sourceValue === 'three') {
        return Promise.resolve(photoThree);
      }

      return Promise.resolve({ width: 200, height: 200, src: sourceValue } as HTMLImageElement);
    });

    component.photoData.set(['one', 'two', 'three']);
    component.selectedLayout.set('3-itpc');

    await (component as any).renderPhotoStrip();

    expect(drawOrder.indexOf('assets/fv 3-itpcstrip.png')).toBeLessThan(drawOrder.indexOf('one'));
    expect(drawOrder.indexOf('assets/fv 3-itpcstrip.png')).toBeLessThan(drawOrder.indexOf('two'));
    expect(drawOrder.indexOf('assets/fv 3-itpcstrip.png')).toBeLessThan(drawOrder.indexOf('three'));
  });
});
