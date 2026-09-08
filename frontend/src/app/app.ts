import { Component } from '@angular/core';
import { Camera } from './camera/camera';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [Camera],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {

}