export interface DecisionLogEntry {
  version: 1;
  ts: number;
  request_id: string;
  trace_id?: string;
  tenant: string;
  client_id: string;
  route: string;
  policy_id: string;
  algorithm: string;
  cost: number;
  decision: 'allowed' | 'denied';
  reason?: string;
  remaining: number;
  reset_ms: number;
  latency_us: number;
}

export interface DecisionLogOptions {
  bufferCapacity?: number;
  allowSampleRate?: number; // default 0.01 (1%)
}

export class DecisionLogRingBuffer {
  private readonly buffer: Array<DecisionLogEntry | null>;
  private readonly capacity: number;
  private readonly allowSampleRate: number;
  private writeIndex = 0;
  private readIndex = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(options: DecisionLogOptions = {}) {
    this.capacity = options.bufferCapacity ?? 10000;
    this.allowSampleRate = options.allowSampleRate ?? 0.01;
    this.buffer = new Array(this.capacity).fill(null);
  }

  shouldSample(decision: 'allowed' | 'denied'): boolean {
    if (decision === 'denied') return true; // 100% of denies sampled
    return Math.random() < this.allowSampleRate; // 1% of allows
  }

  push(entry: DecisionLogEntry): boolean {
    if (!this.shouldSample(entry.decision)) {
      return false;
    }

    if (this.count >= this.capacity) {
      this.droppedCount++;
      return false; // Non-blocking drop
    }

    this.buffer[this.writeIndex] = entry;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.count++;
    return true;
  }

  pop(): DecisionLogEntry | null {
    if (this.count === 0) return null;
    const entry = this.buffer[this.readIndex];
    this.buffer[this.readIndex] = null;
    this.readIndex = (this.readIndex + 1) % this.capacity;
    this.count--;
    return entry;
  }

  drain(maxItems = 1000): DecisionLogEntry[] {
    const items: DecisionLogEntry[] = [];
    while (this.count > 0 && items.length < maxItems) {
      const item = this.pop();
      if (item) items.push(item);
    }
    return items;
  }

  toNDJSON(entries: DecisionLogEntry[]): string {
    return entries.map((e) => JSON.stringify(e)).join('\n');
  }

  get size(): number {
    return this.count;
  }

  get droppedLogsCount(): number {
    return this.droppedCount;
  }

  clear(): void {
    this.buffer.fill(null);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.count = 0;
    this.droppedCount = 0;
  }
}
