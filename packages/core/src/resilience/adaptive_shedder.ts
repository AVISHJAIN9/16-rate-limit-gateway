export type PriorityClass = 'health' | 'admin' | 'allowlisted' | 'normal';

export class AdaptiveLoadShedder {
  private currentLimit: number;
  private inFlight = 0;
  public totalShedded = 0;

  constructor(
    private readonly minLimit: number = 10,
    private readonly maxLimit: number = 500,
    private readonly targetEventLoopDelayMs: number = 50
  ) {
    this.currentLimit = minLimit * 2;
  }

  canAccept(priority: PriorityClass = 'normal', eventLoopDelayMs: number = 0): boolean {
    // Health and admin never shed
    if (priority === 'health' || priority === 'admin') {
      this.inFlight++;
      return true;
    }

    // High event loop delay triggers immediate shedding of normal priority traffic
    if (eventLoopDelayMs > this.targetEventLoopDelayMs && priority === 'normal') {
      this.totalShedded++;
      this.onCongestion();
      return false;
    }

    if (this.inFlight >= this.currentLimit) {
      if (priority === 'allowlisted' && this.inFlight < this.maxLimit) {
        this.inFlight++;
        return true;
      }
      this.totalShedded++;
      this.onCongestion();
      return false;
    }

    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  recordSuccess(): void {
    // AIMD Additive Increase
    if (this.currentLimit < this.maxLimit) {
      this.currentLimit = Math.min(this.maxLimit, this.currentLimit + 1);
    }
  }

  private onCongestion(): void {
    // AIMD Multiplicative Decrease (halve or reduce by 20%)
    this.currentLimit = Math.max(this.minLimit, Math.floor(this.currentLimit * 0.8));
  }

  getLimit(): number {
    return this.currentLimit;
  }

  getInFlight(): number {
    return this.inFlight;
  }
}
