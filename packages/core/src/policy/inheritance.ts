import type { Policy } from '../types.js';

export type InheritanceLayer = 'global' | 'tenant' | 'environment' | 'route-group' | 'route';

export interface PolicyNode {
  id: string;
  parentId?: string;
  layer: InheritanceLayer;
  policy: Policy;
  specified?: Record<string, boolean>; // Explicitly provided fields
}

export interface EffectivePolicy {
  policy: Policy;
  provenance: Record<string, string>; // field -> "layer:id"
}

export const StandardFields = [
  'algorithm',
  'params',
  'priority',
  'failMode',
  'rejectionTemplate',
  'cost',
  'enabled',
  'labels',
  'match',
] as const;

/**
 * Computes the effective policy by folding an inheritance hierarchy from root down to leaf.
 * Detects circular inheritance and tracks field-level provenance.
 */
export function computeEffectivePolicy(
  leafId: string,
  nodeMap: Map<string, PolicyNode> | Record<string, PolicyNode>
): EffectivePolicy {
  const getNode = (id: string): PolicyNode | undefined => {
    return nodeMap instanceof Map ? nodeMap.get(id) : nodeMap[id];
  };

  const chain: PolicyNode[] = [];
  const visited = new Set<string>();

  let currId: string | undefined = leafId;
  while (currId) {
    if (visited.has(currId)) {
      throw new Error(`inheritance cycle detected at policy "${currId}"`);
    }
    visited.add(currId);

    const node = getNode(currId);
    if (!node) {
      throw new Error(`referenced parent policy "${currId}" not found in inheritance tree`);
    }
    chain.push(node);
    currId = node.parentId;
  }

  // Reverse so we apply from root (e.g. global) down to leaf (e.g. route)
  chain.reverse();

  const leaf = chain[chain.length - 1];
  const mergedPolicy: Policy = {
    ...leaf.policy,
    labels: {},
  };

  const provenance: Record<string, string> = {};

  for (const node of chain) {
    const src = `${node.layer}:${node.id}`;

    // Fold basic fields
    if (node.specified?.algorithm || !mergedPolicy.algorithm) {
      mergedPolicy.algorithm = node.policy.algorithm;
      provenance['algorithm'] = src;
    }
    if (node.specified?.params || !mergedPolicy.params) {
      mergedPolicy.params = { ...node.policy.params };
      provenance['params'] = src;
    }
    if (node.specified?.priority || mergedPolicy.priority === undefined) {
      mergedPolicy.priority = node.policy.priority;
      provenance['priority'] = src;
    }
    if (node.specified?.failMode || !mergedPolicy.failMode) {
      mergedPolicy.failMode = node.policy.failMode;
      provenance['failMode'] = src;
    }
    if (node.specified?.cost && node.policy.cost) {
      mergedPolicy.cost = { ...node.policy.cost };
      provenance['cost'] = src;
    }
    if (node.policy.labels) {
      mergedPolicy.labels = { ...mergedPolicy.labels, ...node.policy.labels };
      provenance['labels'] = src;
    }
  }

  return {
    policy: mergedPolicy,
    provenance,
  };
}
