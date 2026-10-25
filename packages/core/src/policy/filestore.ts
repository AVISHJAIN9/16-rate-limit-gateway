import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Policy } from '../types.js';
import { defaultClock, type Clock } from '../clock.js';

export interface FileStoreConfig {
  dir: string;
  fsync?: 'always' | 'periodic' | 'never';
  snapshotEveryN?: number;
  clock?: Clock;
}

export interface WALRecord {
  ts: number;
  tenant: string;
  action: 'save_policy' | 'delete_policy' | 'save_version' | 'prune_versions';
  payload: any;
}

export interface PolicyVersionRecord {
  version: number;
  policy: Policy;
  author?: string;
  reason?: string;
  contentHash?: string;
  createdAtMs: number;
}

export class FilePolicyStore {
  private readonly dir: string;
  private readonly fsync: 'always' | 'periodic' | 'never';
  private readonly snapshotEveryN: number;
  private readonly clock: Clock;
  private mutCount = 0;
  private walFd: number | null = null;
  private policies = new Map<string, Policy>(); // key: `${tenant}:${id}`
  private versions = new Map<string, PolicyVersionRecord[]>(); // key: `${tenant}:${id}`

  constructor(config: FileStoreConfig) {
    this.dir = config.dir;
    this.fsync = config.fsync ?? 'always';
    this.snapshotEveryN = config.snapshotEveryN ?? 0;
    this.clock = config.clock ?? defaultClock;

    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }

    this.recover();
    this.openWAL();
  }

  private key(tenant: string, id: string): string {
    return `${tenant}:${id}`;
  }

  private recover(): void {
    const snapshotPath = path.join(this.dir, 'snapshot.json');
    if (fs.existsSync(snapshotPath)) {
      try {
        const raw = fs.readFileSync(snapshotPath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.policies)) {
          for (const p of data.policies) {
            this.policies.set(this.key(p.tenant || 'global', p.id), p);
          }
        }
        if (data.versions && typeof data.versions === 'object') {
          for (const [k, vList] of Object.entries(data.versions)) {
            this.versions.set(k, vList as PolicyVersionRecord[]);
          }
        }
      } catch (_err: any) {
        // Corrupted snapshot recovery fallback
      }
    }

    const walPath = path.join(this.dir, 'wal.jsonl');
    if (fs.existsSync(walPath)) {
      const content = fs.readFileSync(walPath, 'utf8');
      const lines = content.split('\n');
      let validBytesOffset = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) {
          validBytesOffset += lines[i].length + 1;
          continue;
        }

        try {
          const rec: WALRecord = JSON.parse(line);
          this.applyRecord(rec);
          validBytesOffset += Buffer.byteLength(lines[i], 'utf8') + 1;
        } catch {
          // Truncated / torn write detected at end of file. Truncate back to valid byte offset.
          try {
            fs.truncateSync(walPath, validBytesOffset);
          } catch {
            // Ignore truncate error
          }
          break;
        }
      }
    }
  }

  private applyRecord(rec: WALRecord): void {
    const tenant = rec.tenant || 'global';
    switch (rec.action) {
      case 'save_policy': {
        const p: Policy = rec.payload;
        this.policies.set(this.key(tenant, p.id), p);
        break;
      }
      case 'delete_policy': {
        const id: string = rec.payload.id;
        this.policies.delete(this.key(tenant, id));
        break;
      }
      case 'save_version': {
        const v: PolicyVersionRecord = rec.payload;
        const k = this.key(tenant, v.policy.id);
        const list = this.versions.get(k) || [];
        list.push(v);
        this.versions.set(k, list);
        break;
      }
      case 'prune_versions': {
        const { policyId, keepCount } = rec.payload;
        const k = this.key(tenant, policyId);
        const list = this.versions.get(k) || [];
        if (list.length > keepCount) {
          this.versions.set(k, list.slice(list.length - keepCount));
        }
        break;
      }
    }
  }

  private openWAL(): void {
    const walPath = path.join(this.dir, 'wal.jsonl');
    this.walFd = fs.openSync(walPath, 'a');
  }

  private writeWAL(rec: WALRecord): void {
    if (this.walFd === null) {
      this.openWAL();
    }
    const line = JSON.stringify(rec) + '\n';
    fs.writeSync(this.walFd!, line);
    if (this.fsync === 'always') {
      fs.fsyncSync(this.walFd!);
    }

    this.mutCount++;
    if (this.snapshotEveryN > 0 && this.mutCount >= this.snapshotEveryN) {
      this.snapshot();
      this.mutCount = 0;
    }
  }

  savePolicy(tenant: string, policy: Policy): void {
    const t = tenant || policy.tenant || 'global';
    const rec: WALRecord = {
      ts: this.clock.nowMs(),
      tenant: t,
      action: 'save_policy',
      payload: policy,
    };
    this.policies.set(this.key(t, policy.id), policy);
    this.writeWAL(rec);
  }

  getPolicy(tenant: string, id: string): Policy | null {
    return this.policies.get(this.key(tenant || 'global', id)) ?? null;
  }

  listPolicies(tenant?: string): Policy[] {
    const res: Policy[] = [];
    for (const [k, p] of this.policies.entries()) {
      if (!tenant || tenant === '*' || k.startsWith(`${tenant}:`)) {
        res.push(p);
      }
    }
    return res;
  }

  deletePolicy(tenant: string, id: string): boolean {
    const t = tenant || 'global';
    const k = this.key(t, id);
    if (!this.policies.has(k)) return false;

    this.policies.delete(k);
    this.writeWAL({
      ts: this.clock.nowMs(),
      tenant: t,
      action: 'delete_policy',
      payload: { id },
    });
    return true;
  }

  saveVersion(tenant: string, id: string, version: PolicyVersionRecord): void {
    const t = tenant || 'global';
    const k = this.key(t, id);
    const list = this.versions.get(k) || [];
    list.push(version);
    this.versions.set(k, list);

    this.writeWAL({
      ts: this.clock.nowMs(),
      tenant: t,
      action: 'save_version',
      payload: version,
    });
  }

  getVersions(tenant: string, id: string): PolicyVersionRecord[] {
    return this.versions.get(this.key(tenant || 'global', id)) || [];
  }

  snapshot(): void {
    const snapshotPath = path.join(this.dir, 'snapshot.json');
    const tmpPath = path.join(this.dir, 'snapshot.json.tmp');

    const data = {
      timestamp: this.clock.nowMs(),
      policies: Array.from(this.policies.values()),
      versions: Object.fromEntries(this.versions.entries()),
    };

    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, snapshotPath);
  }

  close(): void {
    if (this.walFd !== null) {
      fs.closeSync(this.walFd);
      this.walFd = null;
    }
  }
}
