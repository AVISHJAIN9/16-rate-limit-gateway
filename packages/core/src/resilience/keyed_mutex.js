/**
 * F97: Deadlock-free minimal locking with watchdog timeout and diagnostic dump.
 */
export class KeyedMutex {
    defaultTimeoutMs;
    queues = new Map();
    lockedKeys = new Set();
    constructor(defaultTimeoutMs = 3000) {
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    async acquire(key, timeoutMs = this.defaultTimeoutMs) {
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
                reject(new Error(`KeyedMutex deadlock watchdog timeout after ${timeoutMs}ms for key='${key}'. Queue depth: ${queue?.length ?? 0}`));
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
    release(key) {
        const queue = this.queues.get(key);
        if (queue && queue.length > 0) {
            const next = queue.shift();
            if (queue.length === 0) {
                this.queues.delete(key);
            }
            next.resolve();
        }
        else {
            this.lockedKeys.delete(key);
        }
    }
    get activeLocksCount() {
        return this.lockedKeys.size;
    }
}
