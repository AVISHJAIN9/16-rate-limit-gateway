import { sortMatchedRoutes } from './priority.js';
export const WeightLiteral = 1000;
export const WeightParamSingle = 100;
export const WeightSuffixWild = 50;
export const WeightMultiWildcard = 1;
export function computeSpecificity(pattern) {
    const clean = pattern.replace(/^\/+|\/+$/g, '');
    if (!clean)
        return WeightLiteral;
    let score = 0;
    const segments = clean.split('/');
    for (const seg of segments) {
        if (seg === '**' || seg.endsWith('...}')) {
            score += WeightMultiWildcard;
        }
        else if (seg.startsWith('*.')) {
            score += WeightSuffixWild;
        }
        else if (seg === '*' || seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) {
            score += WeightParamSingle;
        }
        else {
            score += WeightLiteral;
        }
    }
    return score;
}
function createNode() {
    return {
        children: new Map(),
        suffixChildren: [],
        policies: [],
    };
}
export class RadixTree {
    root = createNode();
    insert(pattern, policy) {
        const specificity = computeSpecificity(pattern);
        const clean = pattern.replace(/^\/+|\/+$/g, '');
        const segments = clean ? clean.split('/') : [];
        let curr = this.root;
        for (let i = 0; i < segments.length; i++) {
            const seg = segments[i];
            if (seg === '**' || seg === '*') {
                if (seg === '**' || i === segments.length - 1) {
                    if (!curr.multiWildcardChild) {
                        curr.multiWildcardChild = createNode();
                        curr.multiWildcardChild.isMultiWildcard = true;
                    }
                    curr = curr.multiWildcardChild;
                    continue;
                }
            }
            if (seg.startsWith('*.')) {
                let suffixNode = curr.suffixChildren.find((n) => n.suffix === seg.slice(1));
                if (!suffixNode) {
                    suffixNode = createNode();
                    suffixNode.suffix = seg.slice(1);
                    curr.suffixChildren.push(suffixNode);
                }
                curr = suffixNode;
            }
            else if (seg.startsWith(':') || (seg.startsWith('{') && seg.endsWith('}'))) {
                const paramName = seg.startsWith(':')
                    ? seg.slice(1)
                    : seg.slice(1, -1);
                if (!curr.paramChild) {
                    curr.paramChild = createNode();
                    curr.paramChild.paramName = paramName;
                }
                curr = curr.paramChild;
            }
            else {
                let child = curr.children.get(seg);
                if (!child) {
                    child = createNode();
                    child.literal = seg;
                    curr.children.set(seg, child);
                }
                curr = child;
            }
        }
        const methods = policy.match?.methods ? new Set(policy.match.methods.map((m) => m.toUpperCase())) : undefined;
        curr.policies.push({
            policy,
            specificity,
            methods,
            host: policy.match?.host,
        });
    }
    match(path, method, host) {
        const clean = path.replace(/^\/+|\/+$/g, '');
        const segments = clean ? clean.split('/') : [];
        const results = [];
        const search = (node, idx, params) => {
            // Check multi-wildcard match at any level
            if (node.multiWildcardChild) {
                for (const entry of node.multiWildcardChild.policies) {
                    if (this.matchesMethodAndHost(entry, method, host)) {
                        results.push({
                            policy: entry.policy,
                            params: { ...params },
                            specificity: entry.specificity,
                        });
                    }
                }
            }
            if (idx === segments.length) {
                // Terminal node
                for (const entry of node.policies) {
                    if (this.matchesMethodAndHost(entry, method, host)) {
                        results.push({
                            policy: entry.policy,
                            params: { ...params },
                            specificity: entry.specificity,
                        });
                    }
                }
                return;
            }
            const seg = segments[idx];
            // 1. Literal match (highest precedence)
            const litChild = node.children.get(seg);
            if (litChild) {
                search(litChild, idx + 1, params);
            }
            // 2. Param match (:paramName)
            if (node.paramChild) {
                const nextParams = { ...params };
                if (node.paramChild.paramName) {
                    nextParams[node.paramChild.paramName] = seg;
                }
                search(node.paramChild, idx + 1, nextParams);
            }
            // 3. Suffix match (*.json)
            for (const suffNode of node.suffixChildren) {
                if (suffNode.suffix && seg.endsWith(suffNode.suffix)) {
                    search(suffNode, idx + 1, params);
                }
            }
        };
        search(this.root, 0, {});
        sortMatchedRoutes(results);
        return results;
    }
    matchesMethodAndHost(entry, method, host) {
        if (entry.methods && method) {
            if (!entry.methods.has(method.toUpperCase()) && !entry.methods.has('*')) {
                return false;
            }
        }
        if (entry.host && host) {
            if (entry.host !== host && entry.host !== '*') {
                return false;
            }
        }
        return true;
    }
}
