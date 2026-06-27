/**
 * SceneAnalyzer — detects significant scene changes between frames
 * Used in streaming mode for intelligent frame capture
 */
export class SceneAnalyzer {
  private lastDescription: string | null = null;
  private changeThreshold = 0.3;

  /**
   * Check if new scene description differs significantly from last
   */
  hasSignificantChange(newDescription: string): boolean {
    if (!this.lastDescription) {
      this.lastDescription = newDescription;
      return true;
    }

    const overlap = this.computeJaccard(this.lastDescription, newDescription);
    const changed = overlap < (1 - this.changeThreshold);

    if (changed) {
      this.lastDescription = newDescription;
    }
    return changed;
  }

  /**
   * Jaccard similarity on character bigrams
   */
  private computeJaccard(a: string, b: string): number {
    const bigramsA = this.getBigrams(a);
    const bigramsB = this.getBigrams(b);

    const setA = new Set(bigramsA);
    const setB = new Set(bigramsB);

    let intersection = 0;
    for (const bg of setA) {
      if (setB.has(bg)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  private getBigrams(s: string): string[] {
    const bigrams: string[] = [];
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.push(s.slice(i, i + 2));
    }
    return bigrams;
  }

  reset(): void {
    this.lastDescription = null;
  }
}
