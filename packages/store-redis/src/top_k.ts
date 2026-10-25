/**
 * Space-Saving Top-K heavy hitters algorithm.
 * Maintains bounded memory state while tracking highest frequency keys.
 */
export class TopKSketch {
  private counts = new Map<string, number>();
  private errors = new Map<string, number>();

  constructor(private readonly capacity: number = 100) {}

  add(key: string, count: number = 1): void {
    if (this.counts.has(key)) {
      this.counts.set(key, (this.counts.get(key) || 0) + count);
      return;
    }

    if (this.counts.size < this.capacity) {
      this.counts.set(key, count);
      this.errors.set(key, 0);
      return;
    }

    // Find minimum entry
    let minKey = '';
    let minCount = Infinity;
    for (const [k, v] of this.counts.entries()) {
      if (v < minCount) {
        minCount = v;
        minKey = k;
      }
    }

    // Replace minKey with key
    this.counts.delete(minKey);
    this.errors.delete(minKey);

    this.counts.set(key, minCount + count);
    this.errors.set(key, minCount);
  }

  isHot(key: string, threshold: number): boolean {
    const count = this.counts.get(key) || 0;
    return count >= threshold;
  }

  getCount(key: string): number {
    return this.counts.get(key) || 0;
  }

  reset(): void {
    this.counts.clear();
    this.errors.clear();
  }
}
