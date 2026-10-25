import { RadixTree } from './radix.js';
export class DynamicPolicySnapshot {
    version;
    hash;
    policies;
    tree;
    constructor(policies, version = 1, hash = '') {
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
    get generation() {
        return this.version;
    }
    resolve(path, method, host) {
        return this.tree.match(path, method, host);
    }
}
export class AtomicSnapshotReloader {
    currentSnapshot;
    constructor(initialSnapshot) {
        this.currentSnapshot = initialSnapshot ?? new DynamicPolicySnapshot([]);
    }
    getSnapshot() {
        return this.currentSnapshot;
    }
    reload(newSnapshot) {
        // Atomic reference assignment in JavaScript
        this.currentSnapshot = newSnapshot;
    }
}
