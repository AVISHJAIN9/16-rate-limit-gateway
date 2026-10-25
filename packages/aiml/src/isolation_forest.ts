export interface IsolationTreeNode {
  splitFeature?: number;
  splitValue?: number;
  size: number;
  left?: IsolationTreeNode;
  right?: IsolationTreeNode;
}

export interface SerializedModel {
  version: 1;
  nTrees: number;
  sampleSize: number;
  threshold: number;
  trees: IsolationTreeNode[];
}

export class IsolationForest {
  private trees: IsolationTreeNode[] = [];
  private threshold = 0.6;
  private sampleSize: number;

  constructor(
    private readonly nTrees = 50,
    sampleSize = 64,
    private readonly seed = 42
  ) {
    this.sampleSize = sampleSize;
  }

  private createRng(initialSeed: number): () => number {
    let s = initialSeed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  fit(data: number[][]): void {
    const rng = this.createRng(this.seed);
    const n = data.length;
    const actualSampleSize = Math.min(this.sampleSize, n);
    const maxDepth = Math.ceil(Math.log2(actualSampleSize));

    this.trees = [];

    for (let t = 0; t < this.nTrees; t++) {
      // Subsample data
      const sampleIndices: number[] = [];
      while (sampleIndices.length < actualSampleSize) {
        const idx = Math.floor(rng() * n);
        if (!sampleIndices.includes(idx)) sampleIndices.push(idx);
      }
      const sample = sampleIndices.map((i) => data[i]);
      const tree = this.buildTree(sample, 0, maxDepth, rng);
      this.trees.push(tree);
    }
  }

  private buildTree(
    X: number[][],
    currentDepth: number,
    maxDepth: number,
    rng: () => number
  ): IsolationTreeNode {
    if (currentDepth >= maxDepth || X.length <= 1) {
      return { size: X.length };
    }

    const numFeatures = X[0].length;
    const splitFeature = Math.floor(rng() * numFeatures);

    const values = X.map((row) => row[splitFeature]);
    const min = Math.min(...values);
    const max = Math.max(...values);

    if (min === max) {
      return { size: X.length };
    }

    // Pick uniform random split value
    const splitValue = min + rng() * (max - min);

    const left = X.filter((row) => row[splitFeature] < splitValue);
    const right = X.filter((row) => row[splitFeature] >= splitValue);

    return {
      splitFeature,
      splitValue,
      size: X.length,
      left: this.buildTree(left, currentDepth + 1, maxDepth, rng),
      right: this.buildTree(right, currentDepth + 1, maxDepth, rng)
    };
  }

  private pathLength(x: number[], node: IsolationTreeNode, currentDepth = 0): number {
    if (!node.left || !node.right || node.splitFeature === undefined || node.splitValue === undefined) {
      return currentDepth + this.c(node.size);
    }

    if (x[node.splitFeature] < node.splitValue) {
      return this.pathLength(x, node.left, currentDepth + 1);
    } else {
      return this.pathLength(x, node.right, currentDepth + 1);
    }
  }

  /**
   * Average path length c(n) of unsuccessful searches in a Binary Search Tree
   */
  private c(n: number): number {
    if (n <= 1) return 0;
    if (n === 2) return 1;
    const eulerGamma = 0.5772156649;
    return 2 * (Math.log(n - 1) + eulerGamma) - (2 * (n - 1)) / n;
  }

  /**
   * Anomaly score: s(x, n) = 2^(- E(h(x)) / c(n))
   * Score close to 1: anomaly; score < 0.5: normal
   */
  score(x: number[]): number {
    if (this.trees.length === 0) return 0;
    let totalPath = 0;
    for (const tree of this.trees) {
      totalPath += this.pathLength(x, tree);
    }
    const avgPath = totalPath / this.trees.length;
    const cn = this.c(this.sampleSize);
    if (cn === 0) return 0.5;
    return Math.pow(2, -avgPath / cn);
  }

  isAnomaly(x: number[]): boolean {
    return this.score(x) >= this.threshold;
  }

  calibrateThreshold(validationData: number[][], percentile = 95): number {
    const scores = validationData.map((x) => this.score(x)).sort((a, b) => a - b);
    const idx = Math.floor((percentile / 100) * scores.length);
    this.threshold = scores[Math.min(idx, scores.length - 1)] ?? 0.6;
    return this.threshold;
  }

  exportModel(): SerializedModel {
    return {
      version: 1,
      nTrees: this.nTrees,
      sampleSize: this.sampleSize,
      threshold: this.threshold,
      trees: this.trees
    };
  }

  loadModel(model: SerializedModel): void {
    if (model.version !== 1) {
      throw new Error(`Unsupported model version ${model.version}`);
    }
    this.threshold = model.threshold;
    this.sampleSize = model.sampleSize;
    this.trees = model.trees;
  }
}
