export class AdaptiveLoadShedder {
    minLimit;
    maxLimit;
    targetEventLoopDelayMs;
    currentLimit;
    inFlight = 0;
    totalShedded = 0;
    constructor(minLimit = 10, maxLimit = 500, targetEventLoopDelayMs = 50) {
        this.minLimit = minLimit;
        this.maxLimit = maxLimit;
        this.targetEventLoopDelayMs = targetEventLoopDelayMs;
        this.currentLimit = minLimit * 2;
    }
    canAccept(priority = 'normal', eventLoopDelayMs = 0) {
        // Health and admin never shed
        if (priority === 'health' || priority === 'admin') {
            this.inFlight++;
            return true;
        }
        // High event loop delay triggers immediate shedding of normal priority traffic
        if (eventLoopDelayMs > this.targetEventLoopDelayMs && priority === 'normal') {
            this.totalShedded++;
            this.onCongestion();
            return false;
        }
        if (this.inFlight >= this.currentLimit) {
            if (priority === 'allowlisted' && this.inFlight < this.maxLimit) {
                this.inFlight++;
                return true;
            }
            this.totalShedded++;
            this.onCongestion();
            return false;
        }
        this.inFlight++;
        return true;
    }
    release() {
        this.inFlight = Math.max(0, this.inFlight - 1);
    }
    recordSuccess() {
        // AIMD Additive Increase
        if (this.currentLimit < this.maxLimit) {
            this.currentLimit = Math.min(this.maxLimit, this.currentLimit + 1);
        }
    }
    onCongestion() {
        // AIMD Multiplicative Decrease (halve or reduce by 20%)
        this.currentLimit = Math.max(this.minLimit, Math.floor(this.currentLimit * 0.8));
    }
    getLimit() {
        return this.currentLimit;
    }
    getInFlight() {
        return this.inFlight;
    }
}
