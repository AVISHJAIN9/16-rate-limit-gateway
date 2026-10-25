import type { CostSpec } from './types.js';

export interface ResolveCostInput {
  spec?: CostSpec;
  headerCost?: string | number | null;
  method?: string;
  route?: string;
  bodyBytes?: number;
}

export class CostResolver {
  static resolve(input: ResolveCostInput): number {
    const { spec, headerCost, route, bodyBytes } = input;
    const minCost = spec?.minCost ?? 1;
    const maxCost = spec?.maxCost ?? 1000;

    let computedCost = spec?.static ?? 1;

    // Route multiplier
    if (route && spec?.routeMultiplier && spec.routeMultiplier[route]) {
      computedCost *= spec.routeMultiplier[route];
    }

    // Header hint (if specified)
    if (headerCost !== undefined && headerCost !== null && headerCost !== '') {
      const parsedHeader = typeof headerCost === 'number' ? headerCost : Number(headerCost);
      if (!Number.isFinite(parsedHeader) || parsedHeader <= 0 || Number.isNaN(parsedHeader)) {
        throw new Error('Invalid cost header: must be a positive finite number');
      }
      computedCost = parsedHeader;
    }

    // Body size factor
    if (bodyBytes !== undefined && spec?.bodySizeFactor && spec.bodySizeFactor > 0) {
      const bodyAddition = Math.ceil(bodyBytes / spec.bodySizeFactor);
      computedCost += bodyAddition;
    }

    // Clamp to [minCost, maxCost]
    return Math.max(minCost, Math.min(maxCost, Math.floor(computedCost)));
  }
}
