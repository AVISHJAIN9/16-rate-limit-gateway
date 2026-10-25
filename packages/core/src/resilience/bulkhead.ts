export class BulkheadPool {
  private inFlight = new Map<string, number>();

  constructor(public readonly maxConcurrentPerSubject: number = 50) {}

  acquire(subject: string): boolean {
    const current = this.inFlight.get(subject) || 0;
    if (current >= this.maxConcurrentPerSubject) {
      return false; // Bulkhead capacity exceeded
    }
    this.inFlight.set(subject, current + 1);
    return true;
  }

  release(subject: string): void {
    const current = this.inFlight.get(subject) || 0;
    if (current <= 1) {
      this.inFlight.delete(subject);
    } else {
      this.inFlight.set(subject, current - 1);
    }
  }

  getInFlight(subject: string): number {
    return this.inFlight.get(subject) || 0;
  }

  clear(): void {
    this.inFlight.clear();
  }
}
