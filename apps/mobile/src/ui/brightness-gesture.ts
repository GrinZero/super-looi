/** Gesture arbitration stays independent of React so cancellation can be tested. */
export class BrightnessGesture {
  active = false;
  cancelled = false;
  isHorizontalDrag = false;
  didMove = false;
  private startX = 0;
  private startY = 0;
  private localX = 0;

  start(pageX: number, pageY: number, localX: number): void {
    this.active = true;
    this.cancelled = false;
    this.isHorizontalDrag = false;
    this.didMove = false;
    this.startX = pageX;
    this.startY = pageY;
    this.localX = localX;
  }

  move(pageX: number, pageY: number): void {
    const dx = Math.abs(pageX - this.startX);
    const dy = Math.abs(pageY - this.startY);
    if (dx >= 6 || dy >= 6) this.didMove = true;
    if (dy > dx && dy > 10) this.cancel();
  }

  canClaim(dx: number, dy: number): boolean {
    return this.active && !this.cancelled && Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy);
  }

  claim(): void {
    if (this.active && !this.cancelled) this.isHorizontalDrag = true;
  }

  targetAt(pageX: number, width: number): number {
    const x = this.localX + pageX - this.startX;
    return Math.max(1, Math.min(255, Math.round(x / Math.max(1, width) * 255)));
  }

  release(pageX: number, pageY: number, width: number): number | null {
    this.move(pageX, pageY);
    const commit = this.active && !this.cancelled && (this.isHorizontalDrag || !this.didMove);
    const target = commit ? this.targetAt(pageX, width) : null;
    this.active = false;
    this.isHorizontalDrag = false;
    return target;
  }

  cancel(): void {
    this.cancelled = true;
    this.active = false;
    this.isHorizontalDrag = false;
  }
}
