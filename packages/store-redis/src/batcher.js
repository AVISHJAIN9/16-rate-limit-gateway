export class PipelineBatcher {
    executeBatch;
    maxBatchSize;
    maxLingerMs;
    queue = [];
    timer = null;
    constructor(executeBatch, maxBatchSize = 50, maxLingerMs = 2) {
        this.executeBatch = executeBatch;
        this.maxBatchSize = maxBatchSize;
        this.maxLingerMs = maxLingerMs;
    }
    schedule(req) {
        return new Promise((resolve, reject) => {
            if (req.signal?.aborted) {
                return reject(new Error('Operation aborted'));
            }
            const item = {
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
            }
            else if (!this.timer) {
                this.timer = setTimeout(() => this.flush(), this.maxLingerMs);
            }
        });
    }
    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.queue.length === 0)
            return;
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
