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

  it('moves to layout selection after capturing the selected number of photos', () => {
    component.photoData.set(['one', 'two', 'three']);

    component.continuePhoto();

    expect(component.boothStep()).toBe('layout');
  });

  it('keeps the selected layout when the user changes it', () => {
    component.selectLayout('dark');

    expect(component.selectedLayout()).toBe('dark');
  });
});
