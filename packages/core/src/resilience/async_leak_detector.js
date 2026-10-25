export class AsyncLeakDetector {
    static takeSnapshot() {
        let activeResources = [];
        if (typeof process.getActiveResourcesInfo === 'function') {
            activeResources = process.getActiveResourcesInfo();
        }
        return {
            activeResources,
            count: activeResources.length,
        };
    }
    static assertNoLeak(baseline, allowedGrowth = 2) {
        const current = this.takeSnapshot();
        const growth = current.count - baseline.count;
        if (growth > allowedGrowth) {
            return {
                leaked: true,
                growth,
                details: current.activeResources,
            };
        }
        return { leaked: false, growth };
    }
}
