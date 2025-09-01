/**
 * DBSCAN (Density-Based Spatial Clustering of Applications with Noise) implementation
 * for clustering memory embeddings based on vector similarity
 */

export interface DBSCANPoint {
  id: string;
  embedding: number[];
  clusterId?: number;
  visited?: boolean;
  noise?: boolean;
}

export interface DBSCANConfig {
  epsilon: number; // Maximum distance between two points in the same neighborhood
  minPoints: number; // Minimum number of points to form a dense region
  distanceFunction?: (a: number[], b: number[]) => number;
}

export class DBSCAN {
  private epsilon: number;
  private minPoints: number;
  private distanceFunction: (a: number[], b: number[]) => number;
  private points: Map<string, DBSCANPoint>;
  private clusterId: number;

  constructor(config: DBSCANConfig) {
    this.epsilon = config.epsilon;
    this.minPoints = config.minPoints;
    this.distanceFunction = config.distanceFunction || this.cosineDistance;
    this.points = new Map();
    this.clusterId = 0;
  }

  /**
   * Cosine distance function (1 - cosine similarity)
   * Better for high-dimensional embeddings than Euclidean distance
   */
  private cosineDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same dimension');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] ?? 0;
      const bVal = b[i] ?? 0;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 1; // Maximum distance if one vector is zero
    }

    const cosineSimilarity = dotProduct / (normA * normB);
    return 1 - cosineSimilarity; // Convert similarity to distance
  }

  /**
   * Main clustering function
   */
  cluster(points: DBSCANPoint[]): Map<number, string[]> {
    // Initialize points map
    this.points.clear();
    this.clusterId = 0;

    for (const point of points) {
      this.points.set(point.id, {
        ...point,
        visited: false,
        noise: false,
      });
    }

    const clusters = new Map<number, string[]>();

    // Process each unvisited point
    for (const [pointId, point] of this.points) {
      if (point.visited) continue;

      point.visited = true;
      const neighbors = this.getNeighbors(pointId);

      if (neighbors.length < this.minPoints) {
        // Mark as noise (might be changed later if in another point's neighborhood)
        point.noise = true;
      } else {
        // Start new cluster
        this.clusterId++;
        clusters.set(this.clusterId, []);
        this.expandCluster(pointId, neighbors, this.clusterId, clusters);
      }
    }

    return clusters;
  }

  /**
   * Get all points within epsilon distance of the given point
   */
  private getNeighbors(pointId: string): string[] {
    const point = this.points.get(pointId);
    if (!point) return [];

    const neighbors: string[] = [];

    for (const [otherId, otherPoint] of this.points) {
      if (otherId === pointId) continue;

      const distance = this.distanceFunction(point.embedding, otherPoint.embedding);
      if (distance <= this.epsilon) {
        neighbors.push(otherId);
      }
    }

    return neighbors;
  }

  /**
   * Expand cluster from a core point
   */
  private expandCluster(
    pointId: string,
    neighbors: string[],
    clusterId: number,
    clusters: Map<number, string[]>
  ): void {
    const point = this.points.get(pointId);
    if (!point) return;

    // Add point to cluster
    point.clusterId = clusterId;
    point.noise = false;
    clusters.get(clusterId)?.push(pointId);

    // Process all neighbors
    const neighborQueue = [...neighbors];

    while (neighborQueue.length > 0) {
      const neighborId = neighborQueue.shift();
      if (!neighborId) continue;
      const neighbor = this.points.get(neighborId);
      if (!neighbor) continue;

      if (!neighbor.visited) {
        neighbor.visited = true;
        const neighborNeighbors = this.getNeighbors(neighborId);

        if (neighborNeighbors.length >= this.minPoints) {
          // This neighbor is also a core point, add its neighbors to queue
          for (const nn of neighborNeighbors) {
            if (!neighborQueue.includes(nn)) {
              neighborQueue.push(nn);
            }
          }
        }
      }

      // Add neighbor to cluster if not already in one
      if (neighbor.clusterId === undefined) {
        neighbor.clusterId = clusterId;
        neighbor.noise = false;
        clusters.get(clusterId)?.push(neighborId);
      }
    }
  }

  /**
   * Get cluster statistics
   */
  getStatistics(): {
    totalPoints: number;
    clusteredPoints: number;
    noisePoints: number;
    clusterCount: number;
    averageClusterSize: number;
    largestCluster: number;
    smallestCluster: number;
  } {
    let clusteredPoints = 0;
    let noisePoints = 0;
    const clusterSizes = new Map<number, number>();

    for (const point of this.points.values()) {
      if (point.clusterId !== undefined) {
        clusteredPoints++;
        const count = clusterSizes.get(point.clusterId) || 0;
        clusterSizes.set(point.clusterId, count + 1);
      } else if (point.noise) {
        noisePoints++;
      }
    }

    const sizes = Array.from(clusterSizes.values());
    const averageSize = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
    const largestCluster = sizes.length > 0 ? Math.max(...sizes) : 0;
    const smallestCluster = sizes.length > 0 ? Math.min(...sizes) : 0;

    return {
      totalPoints: this.points.size,
      clusteredPoints,
      noisePoints,
      clusterCount: clusterSizes.size,
      averageClusterSize: averageSize,
      largestCluster,
      smallestCluster,
    };
  }

  /**
   * Calculate cluster quality metrics
   */
  calculateSilhouetteScore(): number {
    // Simplified silhouette score calculation
    let totalScore = 0;
    let scoredPoints = 0;

    for (const [pointId, point] of this.points) {
      if (point.clusterId === undefined) continue;

      // Calculate mean intra-cluster distance
      const clusterPoints = Array.from(this.points.values()).filter(
        (p) => p.clusterId === point.clusterId && p.id !== pointId
      );

      if (clusterPoints.length === 0) continue;

      const intraDistance =
        clusterPoints.reduce((sum, p) => sum + this.distanceFunction(point.embedding, p.embedding), 0) /
        clusterPoints.length;

      // Calculate mean nearest-cluster distance
      const otherClusters = new Set(
        Array.from(this.points.values())
          .filter((p) => p.clusterId !== undefined && p.clusterId !== point.clusterId)
          .map((p) => p.clusterId)
      );

      if (otherClusters.size === 0) continue;

      let minInterDistance = Number.POSITIVE_INFINITY;
      for (const otherClusterId of otherClusters) {
        const otherClusterPoints = Array.from(this.points.values()).filter((p) => p.clusterId === otherClusterId);
        const interDistance =
          otherClusterPoints.reduce((sum, p) => sum + this.distanceFunction(point.embedding, p.embedding), 0) /
          otherClusterPoints.length;
        minInterDistance = Math.min(minInterDistance, interDistance);
      }

      // Calculate silhouette coefficient for this point
      const silhouette = (minInterDistance - intraDistance) / Math.max(intraDistance, minInterDistance);
      totalScore += silhouette;
      scoredPoints++;
    }

    return scoredPoints > 0 ? totalScore / scoredPoints : 0;
  }
}

/**
 * Incremental DBSCAN for adding new points to existing clusters
 */
export class IncrementalDBSCAN extends DBSCAN {
  private existingClusters: Map<number, Set<string>>;

  constructor(config: DBSCANConfig) {
    super(config);
    this.existingClusters = new Map();
  }

  /**
   * Add new points to existing clusters or create new ones
   */
  addPoints(newPoints: DBSCANPoint[], existingPoints: DBSCANPoint[]): Map<number, string[]> {
    // First, reconstruct existing cluster structure
    for (const point of existingPoints) {
      if (point.clusterId !== undefined) {
        if (!this.existingClusters.has(point.clusterId)) {
          this.existingClusters.set(point.clusterId, new Set());
        }
        this.existingClusters.get(point.clusterId)?.add(point.id);
      }
    }

    // Process new points
    const allPoints = [...existingPoints, ...newPoints];
    const updatedClusters = this.cluster(allPoints);

    return updatedClusters;
  }
}
