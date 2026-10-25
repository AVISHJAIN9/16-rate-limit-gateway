import { BoundedQueue } from '@rlgw/core';
import type { GraduatedJailManager } from '@rlgw/security';
import { IsolationForest } from './isolation_forest.js';

export interface InferenceTask {
  subjectId: string;
  features: number[];
  timestampMs: number;
}

export class InferenceScorerWorker {
  private readonly queue: BoundedQueue<InferenceTask>;
  private isRunning = false;
  private readonly latenciesUs: number[] = [];
  private totalScored = 0;

  constructor(
    private readonly model: IsolationForest,
    private readonly jailManager?: GraduatedJailManager,
    queueCapacity = 5000,
    private readonly observeOnly = true
  ) {
    this.queue = new BoundedQueue(queueCapacity, 'drop_oldest');
  }

  enqueue(task: InferenceTask): boolean {
    return this.queue.push(task);
  }

  processOne(): { scored: boolean; subjectId?: string; score?: number; latencyUs?: number } {
    const task = this.queue.pop();
    if (!task) return { scored: false };

    const start = process.hrtime.bigint();
    const score = this.model.score(task.features);
    const end = process.hrtime.bigint();
    const latencyUs = Number(end - start) / 1000;

    if (this.latenciesUs.length < 5000) {
      this.latenciesUs.push(latencyUs);
    }
    this.totalScored++;

    // In observe mode or active mode:
    if (this.model.isAnomaly(task.features) && this.jailManager && !this.observeOnly) {
      this.jailManager.recordStrike(task.subjectId, task.timestampMs);
    }

    return {
      scored: true,
      subjectId: task.subjectId,
      score,
      latencyUs
    };
  }

  drainAll(): number {
    let processed = 0;
    while (this.queue.size > 0) {
      this.processOne();
      processed++;
    }
    return processed;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get droppedTasksCount(): number {
    return this.queue.droppedCount;
  }

  get p99LatencyUs(): number {
    if (this.latenciesUs.length === 0) return 0;
    const sorted = [...this.latenciesUs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.99)];
  }
}
