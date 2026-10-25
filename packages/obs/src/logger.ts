import pino from 'pino';
import { defaultClock, type Clock } from '@rlgw/core';

export interface StructuredLogFields {
  ts?: number;
  level?: string;
  msg: string;
  request_id?: string;
  trace_id?: string;
  tenant?: string;
  client?: string;
  route?: string;
  policy_id?: string;
  decision?: string;
  reason?: string;
  latency_us?: number;
}

export class GatewayLogger {
  private readonly logger: pino.Logger;
  private readonly errorThrottleMap = new Map<string, { count: number; lastLogged: number }>();
  private readonly clock: Clock;

  constructor(level: string = 'info', clock: Clock = defaultClock) {
    this.clock = clock;
    this.logger = pino({
      level,
      timestamp: () => `,"ts":${this.clock.nowMs()}`,
      formatters: {
        level: (label) => ({ level: label })
      }
    });
  }

  setLevel(level: string): void {
    this.logger.level = level;
  }

  getLevel(): string {
    return this.logger.level;
  }

  info(fields: StructuredLogFields): void {
    this.logger.info(fields, fields.msg);
  }

  warn(fields: StructuredLogFields): void {
    this.logger.warn(fields, fields.msg);
  }

  error(fields: StructuredLogFields): void {
    // Repeated error throttling: throttle identical error msg within 1s
    const now = this.clock.nowMs();
    const entry = this.errorThrottleMap.get(fields.msg);
    if (entry && now - entry.lastLogged < 1000) {
      entry.count++;
      return; // Throttled
    }

    if (entry && entry.count > 1) {
      this.logger.error(
        { ...fields, repeated_suppressed_count: entry.count - 1 },
        `${fields.msg} (suppressed ${entry.count - 1} duplicates)`
      );
    } else {
      this.logger.error(fields, fields.msg);
    }
    this.errorThrottleMap.set(fields.msg, { count: 1, lastLogged: now });
  }
}
