import chokidar, { type FSWatcher } from 'chokidar';
import { defaultClock, type Clock } from '@rlgw/core';

export interface WatcherOptions {
  debounceMs?: number;
  onReload: (filePath: string) => Promise<void> | void;
  onError?: (err: Error) => void;
  clock?: Clock;
}

export class PolicyFileWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private lastReloadTime = 0;
  private isReloading = false;

  private readonly clock: Clock;

  constructor(
    private readonly targetPath: string,
    private readonly options: WatcherOptions
  ) {
    this.clock = options.clock ?? defaultClock;
  }

  start(): void {
    const debounceMs = this.options.debounceMs ?? 100;

    this.watcher = chokidar.watch(this.targetPath, {
      persistent: true,
      ignoreInitial: true
    });

    const triggerReload = (filePath: string): void => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(async () => {
        if (this.isReloading) return;
        this.isReloading = true;
        try {
          await this.options.onReload(filePath);
          this.generation++;
          this.lastReloadTime = this.clock.nowMs();
        } catch (err: any) {
          if (this.options.onError) {
            this.options.onError(err);
          }
        } finally {
          this.isReloading = false;
        }
      }, debounceMs);
    };

    this.watcher.on('change', triggerReload);
    this.watcher.on('add', triggerReload);
    this.watcher.on('error', (err: any) => {
      if (this.options.onError) {
        this.options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get lastReloadTimestamp(): number {
    return this.lastReloadTime;
  }

  async close(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
