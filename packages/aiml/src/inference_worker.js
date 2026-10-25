import { BoundedQueue } from '@rlgw/core';
export class InferenceScorerWorker {
    model;
    jailManager;
    observeOnly;
    queue;
    isRunning = false;
    latenciesUs = [];
    totalScored = 0;
    constructor(model, jailManager, queueCapacity = 5000, observeOnly = true) {
        this.model = model;
        this.jailManager = jailManager;
        this.observeOnly = observeOnly;
        this.queue = new BoundedQueue(queueCapacity, 'drop_oldest');
    }
    enqueue(task) {
        return this.queue.push(task);
    }
    processOne() {
        const task = this.queue.pop();
        if (!task)
            return { scored: false };
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
    drainAll() {
        let processed = 0;
        while (this.queue.size > 0) {
            this.processOne();
            processed++;
        }
        return processed;
    }
    get queueSize() {
        return this.queue.size;
    }
    get droppedTasksCount() {
        return this.queue.droppedCount;
    }
    get p99LatencyUs() {
        if (this.latenciesUs.length === 0)
            return 0;
        const sorted = [...this.latenciesUs].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.99)];
    }
}
