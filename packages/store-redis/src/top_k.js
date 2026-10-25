/**
 * Space-Saving Top-K heavy hitters algorithm.
 * Maintains bounded memory state while tracking highest frequency keys.
 */
export class TopKSketch {
    capacity;
    counts = new Map();
    errors = new Map();
    constructor(capacity = 100) {
        this.capacity = capacity;
    }
    add(key, count = 1) {
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
    isHot(key, threshold) {
        const count = this.counts.get(key) || 0;
        return count >= threshold;
    }
    getCount(key) {
        return this.counts.get(key) || 0;
    }
    reset() {
        this.counts.clear();
        this.errors.clear();
    }
}
