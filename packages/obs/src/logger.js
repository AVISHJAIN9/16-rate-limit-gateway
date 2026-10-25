import pino from 'pino';
import { defaultClock } from '@rlgw/core';
export class GatewayLogger {
    logger;
    errorThrottleMap = new Map();
    clock;
    constructor(level = 'info', clock = defaultClock) {
        this.clock = clock;
        this.logger = pino({
            level,
            timestamp: () => `,"ts":${this.clock.nowMs()}`,
            formatters: {
                level: (label) => ({ level: label })
            }
        });
    }
    setLevel(level) {
        this.logger.level = level;
    }
    getLevel() {
        return this.logger.level;
    }
    info(fields) {
        this.logger.info(fields, fields.msg);
    }
    warn(fields) {
        this.logger.warn(fields, fields.msg);
    }
    error(fields) {
        // Repeated error throttling: throttle identical error msg within 1s
        const now = this.clock.nowMs();
        const entry = this.errorThrottleMap.get(fields.msg);
        if (entry && now - entry.lastLogged < 1000) {
            entry.count++;
            return; // Throttled
        }
        if (entry && entry.count > 1) {
            this.logger.error({ ...fields, repeated_suppressed_count: entry.count - 1 }, `${fields.msg} (suppressed ${entry.count - 1} duplicates)`);
        }
        else {
            this.logger.error(fields, fields.msg);
        }
        this.errorThrottleMap.set(fields.msg, { count: 1, lastLogged: now });
    }
}
