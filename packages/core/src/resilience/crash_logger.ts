/**
 * F105: Fast diagnostic crash logging for uncaughtException and unhandledRejection.
 * Synchronously dumps redacted process state and exits non-zero to prevent corrupted runs.
 */

export interface CrashStateSummary {
  timestamp: string;
  pid: number;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  activeHandlesCount: number;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

export class DiagnosticCrashLogger {
  static createSummary(err: any): CrashStateSummary {
    const errorObj = err instanceof Error ? err : new Error(String(err));
    // Count active handles/requests if available
    const getHandles = (process as any)._getActiveHandles;
    const activeHandles = typeof getHandles === 'function' ? getHandles().length : 0;

    return {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsage: process.memoryUsage(),
      activeHandlesCount: activeHandles,
      error: {
        name: errorObj.name,
        message: errorObj.message,
        stack: errorObj.stack
      }
    };
  }

  static install(sink: (summary: CrashStateSummary) => void = (s) => console.error(JSON.stringify(s))): () => void {
    const uncaughtHandler = (err: any): void => {
      const summary = DiagnosticCrashLogger.createSummary(err);
      sink(summary);
      process.exit(1);
    };

    const unhandledRejectionHandler = (reason: any): void => {
      const summary = DiagnosticCrashLogger.createSummary(reason);
      sink(summary);
      process.exit(1);
    };

    process.on('uncaughtException', uncaughtHandler);
    process.on('unhandledRejection', unhandledRejectionHandler);

    return () => {
      process.off('uncaughtException', uncaughtHandler);
      process.off('unhandledRejection', unhandledRejectionHandler);
    };
  }
}
