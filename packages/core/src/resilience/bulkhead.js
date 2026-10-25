export class BulkheadPool {
    maxConcurrentPerSubject;
    inFlight = new Map();
    constructor(maxConcurrentPerSubject = 50) {
        this.maxConcurrentPerSubject = maxConcurrentPerSubject;
    }
    acquire(subject) {
        const current = this.inFlight.get(subject) || 0;
        if (current >= this.maxConcurrentPerSubject) {
            return false; // Bulkhead capacity exceeded
        }
        this.inFlight.set(subject, current + 1);
        return true;
    }
    release(subject) {
        const current = this.inFlight.get(subject) || 0;
        if (current <= 1) {
            this.inFlight.delete(subject);
        }
        else {
            this.inFlight.set(subject, current - 1);
        }
    }
    getInFlight(subject) {
        return this.inFlight.get(subject) || 0;
    }
    clear() {
        this.inFlight.clear();
    }
}
