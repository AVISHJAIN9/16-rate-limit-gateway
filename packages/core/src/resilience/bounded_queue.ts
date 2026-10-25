export type OverflowPolicy = 'drop_oldest' | 'drop_newest' | 'reject';

export class BoundedQueue<T> {
  private items: T[] = [];
  public droppedCount = 0;

  constructor(
    public readonly capacity: number,
    public readonly overflowPolicy: OverflowPolicy = 'drop_oldest'
  ) {}

  push(item: T): boolean {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return true;
    }

    this.droppedCount++;
    switch (this.overflowPolicy) {
      case 'reject':
        return false;
      case 'drop_newest':
        return false;
      case 'drop_oldest':
        this.items.shift();
        this.items.push(item);
        return true;
    }
  }

  pop(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
    this.droppedCount = 0;
  }
}
