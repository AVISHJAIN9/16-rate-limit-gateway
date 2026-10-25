import type { Policy } from '../types.js';
import { RadixTree } from './radix.js';
import type { MatchedRoute } from './priority.js';

export class DynamicPolicySnapshot {
  readonly version: number;
  readonly hash: string;
  readonly policies: Policy[];
  private readonly tree: RadixTree;

  constructor(policies: Policy[], version: number = 1, hash: string = '') {
    this.policies = policies;
    this.version = version;
    this.hash = hash;
    this.tree = new RadixTree();

    for (const p of policies) {
      if (p.enabled !== false) {
        this.tree.insert(p.match?.route || '/*', p);
      }
    }
  }

  get generation(): number {
    return this.version;
  }

  resolve(path: string, method?: string, host?: string): MatchedRoute[] {
    return this.tree.match(path, method, host);
  }
}

export class AtomicSnapshotReloader {
  private currentSnapshot: DynamicPolicySnapshot;

  constructor(initialSnapshot?: DynamicPolicySnapshot) {
    this.currentSnapshot = initialSnapshot ?? new DynamicPolicySnapshot([]);
  }

  getSnapshot(): DynamicPolicySnapshot {
    return this.currentSnapshot;
  }

  reload(newSnapshot: DynamicPolicySnapshot): void {
    // Atomic reference assignment in JavaScript
    this.currentSnapshot = newSnapshot;
  }
}
