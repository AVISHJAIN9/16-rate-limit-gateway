import { defaultClock } from '@rlgw/core';
export class JailManager {
    entries = new Map();
    observeMode = false;
    baseBanDurationMs;
    maxBanDurationMs;
    clock;
    constructor(options = {}) {
        this.observeMode = options.observeMode ?? false;
        this.baseBanDurationMs = options.baseBanDurationMs ?? 60_000; // 1 min
        this.maxBanDurationMs = options.maxBanDurationMs ?? 3_600_000; // 1 hour
        this.clock = options.clock ?? defaultClock;
    }
    recordViolation(subject, reason = 'rate_abuse', nowMs = this.clock.nowMs()) {
        const entry = this.entries.get(subject) || {
            subject,
            state: 'clean',
            escalationLevel: 0,
            violationsCount: 0,
        };
        entry.violationsCount++;
        entry.reason = reason;
        if (entry.violationsCount === 1) {
            entry.state = 'warn';
        }
        else if (entry.violationsCount === 2) {
            entry.state = 'tighten';
        }
        else {
            entry.state = 'banned';
            entry.escalationLevel++;
            const banDuration = Math.min(this.maxBanDurationMs, this.baseBanDurationMs * Math.pow(2, entry.escalationLevel - 1));
            entry.bannedUntilMs = nowMs + banDuration;
        }
        this.entries.set(subject, entry);
        return entry;
    }
    recordStrike(subject, nowMs = this.clock.nowMs()) {
        return this.recordViolation(subject, 'ai_anomaly_detected', nowMs);
    }
    checkStatus(subject, nowMs = this.clock.nowMs()) {
        const entry = this.entries.get(subject);
        if (!entry) {
            return { state: 'clean', banned: false, tightenFactor: 1.0 };
        }
        // Check ban expiration
        if (entry.state === 'banned' && entry.bannedUntilMs && nowMs >= entry.bannedUntilMs) {
            entry.state = 'tighten'; // Decay from banned to tighten
            entry.bannedUntilMs = undefined;
        }
        if (entry.state === 'banned') {
            return {
                state: 'banned',
                banned: !this.observeMode,
                tightenFactor: 0.0,
            };
        }
        if (entry.state === 'tighten') {
            return {
                state: 'tighten',
                banned: false,
                tightenFactor: 0.5, // 50% tighter limits
            };
        }
        return {
            state: entry.state,
            banned: false,
            tightenFactor: 1.0,
        };
    }
    release(subject) {
        return this.entries.delete(subject);
    }
    clear() {
        this.entries.clear();
    }
}
export { JailManager as GraduatedJailManager };
