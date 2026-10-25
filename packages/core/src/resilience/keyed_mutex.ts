/**
 * F97: Deadlock-free minimal locking with watchdog timeout and diagnostic dump.
 */

export class KeyedMutex {
  private readonly queues = new Map<string, Array<{ resolve: () => void; reject: (err: Error) => void; timeoutId: NodeJS.Timeout }>>();
  private readonly lockedKeys = new Set<string>();

  constructor(private readonly defaultTimeoutMs = 3000) {}

  async acquire(key: string, timeoutMs = this.defaultTimeoutMs): Promise<() => void> {
    if (!this.lockedKeys.has(key)) {
      this.lockedKeys.add(key);
      return () => this.release(key);
    }

    return new Promise((resolve, reject) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
      }

      const timeoutId = setTimeout(() => {
        // Watchdog tripped
        const currentQueue = this.queues.get(key);
        if (currentQueue) {
          const idx = currentQueue.findIndex((entry) => entry.timeoutId === timeoutId);
          if (idx !== -1) {
            currentQueue.splice(idx, 1);
          }
          if (currentQueue.length === 0) {
            this.queues.delete(key);
          }
        }
        reject(
          new Error(
            `KeyedMutex deadlock watchdog timeout after ${timeoutMs}ms for key='${key}'. Queue depth: ${queue?.length ?? 0}`
          )
        );
      }, timeoutMs);

      queue.push({
        resolve: () => {
          clearTimeout(timeoutId);
          this.lockedKeys.add(key);
          resolve(() => this.release(key));
        },
        reject,
        timeoutId
      });
    });
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(key);
      }
      next.resolve();
    } else {
      this.lockedKeys.delete(key);
    }
  }

  get activeLocksCount(): number {
    return this.lockedKeys.size;
  }
}
