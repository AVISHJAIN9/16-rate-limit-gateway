import chokidar from 'chokidar';
import { defaultClock } from '@rlgw/core';
export class PolicyFileWatcher {
    targetPath;
    options;
    watcher = null;
    debounceTimer = null;
    generation = 0;
    lastReloadTime = 0;
    isReloading = false;
    clock;
    constructor(targetPath, options) {
        this.targetPath = targetPath;
        this.options = options;
        this.clock = options.clock ?? defaultClock;
    }
    start() {
        const debounceMs = this.options.debounceMs ?? 100;
        this.watcher = chokidar.watch(this.targetPath, {
            persistent: true,
            ignoreInitial: true
        });
        const triggerReload = (filePath) => {
            if (this.debounceTimer) {
                clearTimeout(this.debounceTimer);
            }
            this.debounceTimer = setTimeout(async () => {
                if (this.isReloading)
                    return;
                this.isReloading = true;
                try {
                    await this.options.onReload(filePath);
                    this.generation++;
                    this.lastReloadTime = this.clock.nowMs();
                }
                catch (err) {
                    if (this.options.onError) {
                        this.options.onError(err);
                    }
                }
                finally {
                    this.isReloading = false;
                }
            }, debounceMs);
        };
        this.watcher.on('change', triggerReload);
        this.watcher.on('add', triggerReload);
        this.watcher.on('error', (err) => {
            if (this.options.onError) {
                this.options.onError(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    get currentGeneration() {
        return this.generation;
    }
    get lastReloadTimestamp() {
        return this.lastReloadTime;
    }
    async close() {
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
