/** Canvas sparkline of queue depth (queued + ready + active) over time. */
import {
  Component,
  ElementRef,
  effect,
  input,
  viewChild,
} from '@angular/core';
import type { QueueStatPoint } from '../../core/models';

@Component({
  selector: 'app-sparkline',
  template: '<canvas #canvas class="sparkline" height="26"></canvas>',
})
export class Sparkline {
  readonly points = input<QueueStatPoint[] | undefined>();
  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => this.draw(this.points()));
  }

  private draw(points: QueueStatPoint[] | undefined): void {
    const canvas = this.canvas().nativeElement;
    if (!points || points.length < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const h = (canvas.height = 26 * devicePixelRatio);
    const depth = points.map((p) => p.queued + p.ready + p.active);
    const max = Math.max(...depth, 1);
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    depth.forEach((d, i) => {
      const x = (i / (depth.length - 1)) * (w - 2) + 1;
      const y = h - 2 - (d / max) * (h - 6);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim();
    ctx.lineWidth = 1.5 * devicePixelRatio;
    ctx.stroke();
  }
}
