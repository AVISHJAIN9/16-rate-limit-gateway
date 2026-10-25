export class DecisionLogRingBuffer {
    buffer;
    capacity;
    allowSampleRate;
    writeIndex = 0;
    readIndex = 0;
    count = 0;
    droppedCount = 0;
    constructor(options = {}) {
        this.capacity = options.bufferCapacity ?? 10000;
        this.allowSampleRate = options.allowSampleRate ?? 0.01;
        this.buffer = new Array(this.capacity).fill(null);
    }
    shouldSample(decision) {
        if (decision === 'denied')
            return true; // 100% of denies sampled
        return Math.random() < this.allowSampleRate; // 1% of allows
    }
    push(entry) {
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
    pop() {
        if (this.count === 0)
            return null;
        const entry = this.buffer[this.readIndex];
        this.buffer[this.readIndex] = null;
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.count--;
        return entry;
    }
    drain(maxItems = 1000) {
        const items = [];
        while (this.count > 0 && items.length < maxItems) {
            const item = this.pop();
            if (item)
                items.push(item);
        }
        return items;
    }
    toNDJSON(entries) {
        return entries.map((e) => JSON.stringify(e)).join('\n');
    }
    get size() {
        return this.count;
    }
    get droppedLogsCount() {
        return this.droppedCount;
    }
    clear() {
        this.buffer.fill(null);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.count = 0;
        this.droppedCount = 0;
    }
}
