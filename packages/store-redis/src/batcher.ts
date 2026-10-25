import type { AlgorithmSpec, Decision } from '@rlgw/core';

export interface BatchPeekRequest {
  key: string;
  spec: AlgorithmSpec;
  nowMs: number;
  cost: number;
  resolve: (decision: Decision) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
}

export class PipelineBatcher {
  private queue: BatchPeekRequest[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly executeBatch: (requests: BatchPeekRequest[]) => Promise<Decision[]>,
    private readonly maxBatchSize: number = 50,
    private readonly maxLingerMs: number = 2
  ) {}

  schedule(req: Omit<BatchPeekRequest, 'resolve' | 'reject'>): Promise<Decision> {
    return new Promise<Decision>((resolve, reject) => {
      if (req.signal?.aborted) {
        return reject(new Error('Operation aborted'));
      }

      const item: BatchPeekRequest = {
        ...req,
        resolve,
        reject,
      };

      if (req.signal) {
        req.signal.addEventListener('abort', () => {
          const idx = this.queue.indexOf(item);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
            reject(new Error('Operation aborted'));
          }
        });
      }

      this.queue.push(item);

      if (this.queue.length >= this.maxBatchSize) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.maxLingerMs);
      }
    });
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;

    const currentBatch = this.queue.splice(0, this.maxBatchSize);
    this.executeBatch(currentBatch)
      .then((results) => {
        for (let i = 0; i < currentBatch.length; i++) {
          currentBatch[i].resolve(results[i]);
        }
      })
      .catch((err) => {
        for (const item of currentBatch) {
          item.reject(err);
        }
      });
  }
}
