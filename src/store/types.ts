export interface CounterEntry {
  count: number;
  windowStartMs: number;
  resetMs: number;
}

export interface CounterStore {
  increment(_key: string, _cost: number, _nowMs: number): Promise<CounterEntry>;
  get(_key: string, _nowMs: number): Promise<CounterEntry | number | undefined>;
  delete(_key: string): Promise<void>;
  incrBy?(_key: string, _delta: number, _ttlMs?: number): Promise<number>;
  expire?(_key: string, _ttlMs: number): Promise<boolean>;
}
