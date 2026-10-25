export const BinaryKeyWireVersion = 0x01;

export interface KeyBuilderConfig {
  namespace?: string;
  version?: string;
  includePolicyVersion?: boolean;
}

export interface KeyComponents {
  tenant: string;
  scope: string;
  dimension: string;
  policyId: string;
  policyVersion?: number;
  method?: string;
  attributes?: Record<string, string>;
}

export class KeyBuilder {
  private readonly namespace: string;
  private readonly version: string;
  private readonly includePolicyVersion: boolean;

  constructor(config: KeyBuilderConfig = {}) {
    this.namespace = config.namespace ?? 'rl';
    this.version = config.version ?? 'v1';
    this.includePolicyVersion = config.includePolicyVersion ?? false;
  }

  /**
   * Frozen interface method:
   * Generates a Redis cluster hash-tagged key:
   * rl:v1:{<tenant>:<subject>}:<policyId>:<algorithm>[:<windowId>]
   */
  build(tenant: string, subject: string, policyId: string, algorithm: string, windowId?: string | number): string {
    const cleanTenant = String(tenant || 'global').replace(/[:{}]/g, '_');
    const cleanSubject = String(subject || 'default').replace(/[:{}]/g, '_');
    const cleanPolicy = String(policyId || 'pol').replace(/[:{}]/g, '_');
    const base = `${this.namespace}:${this.version}:{${cleanTenant}:${cleanSubject}}:${cleanPolicy}:${algorithm}`;
    return windowId !== undefined ? `${base}:${windowId}` : base;
  }

  /**
   * Produces canonical Redis cluster hash-tagged key:
   * {namespace}:{{tenant}:{subject}}:{scope}:{policyId}[:{METHOD}][:v{version}]
   */
  buildRedisKey(kc: KeyComponents): string {
    const subject = kc.dimension || 'all';
    let key = `${this.namespace}:{${kc.tenant}:${subject}}:${kc.scope}:${kc.policyId}`;
    if (kc.method) {
      key += `:${kc.method.toUpperCase()}`;
    }
    if (this.includePolicyVersion && kc.policyVersion !== undefined) {
      key += `:v${kc.policyVersion}`;
    }
    return key;
  }

  /**
   * Length-prefixed canonical binary key wire format (version 0x01):
   * [1 byte 0x01]
   * [uint16 tenant_len] [tenant]
   * [uint16 scope_len] [scope]
   * [uint16 dimension_len] [dimension]
   * [uint16 policyId_len] [policyId]
   * [uint16 method_len] [method]
   * [optional 8 bytes int64 version]
   * [uint16 attr_count]
   * For each sorted attr: [uint16 k_len][k][uint16 v_len][v]
   */
  buildBinaryKey(kc: KeyComponents): Buffer {
    const chunks: Buffer[] = [];

    // 1. Wire version
    chunks.push(Buffer.from([BinaryKeyWireVersion]));

    const appendLP = (str: string) => {
      const buf = Buffer.from(str, 'utf8');
      const lenBuf = Buffer.allocUnsafe(2);
      lenBuf.writeUInt16BE(buf.length, 0);
      chunks.push(lenBuf, buf);
    };

    appendLP(kc.tenant);
    appendLP(kc.scope);
    appendLP(kc.dimension);
    appendLP(kc.policyId);
    appendLP(kc.method ?? '');

    if (this.includePolicyVersion) {
      const vBuf = Buffer.allocUnsafe(8);
      vBuf.writeBigInt64BE(BigInt(kc.policyVersion ?? 0), 0);
      chunks.push(vBuf);
    }

    if (!kc.attributes || Object.keys(kc.attributes).length === 0) {
      const countBuf = Buffer.alloc(2);
      chunks.push(countBuf);
    } else {
      const sortedKeys = Object.keys(kc.attributes).sort();
      const countBuf = Buffer.allocUnsafe(2);
      countBuf.writeUInt16BE(sortedKeys.length, 0);
      chunks.push(countBuf);

      for (const k of sortedKeys) {
        appendLP(k);
        appendLP(kc.attributes[k] ?? '');
      }
    }

    return Buffer.concat(chunks);
  }
}
