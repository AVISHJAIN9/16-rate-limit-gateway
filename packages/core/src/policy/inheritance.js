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
];
/**
 * Computes the effective policy by folding an inheritance hierarchy from root down to leaf.
 * Detects circular inheritance and tracks field-level provenance.
 */
export function computeEffectivePolicy(leafId, nodeMap) {
    const getNode = (id) => {
        return nodeMap instanceof Map ? nodeMap.get(id) : nodeMap[id];
    };
    const chain = [];
    const visited = new Set();
    let currId = leafId;
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
    const mergedPolicy = {
        ...leaf.policy,
        labels: {},
    };
    const provenance = {};
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
