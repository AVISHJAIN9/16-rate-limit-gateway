export interface ResourceSnapshot {
  activeResources: string[];
  count: number;
}

export class AsyncLeakDetector {
  static takeSnapshot(): ResourceSnapshot {
    let activeResources: string[] = [];
    if (typeof (process as any).getActiveResourcesInfo === 'function') {
      activeResources = (process as any).getActiveResourcesInfo();
    }
    return {
      activeResources,
      count: activeResources.length,
    };
  }

  static assertNoLeak(
    baseline: ResourceSnapshot,
    allowedGrowth: number = 2
  ): { leaked: boolean; growth: number; details?: string[] } {
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
