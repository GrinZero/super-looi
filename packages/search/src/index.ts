/*!
 * Tokenization and field-weighted BM25 adapted from Pi 1.5.0:
 * https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/extensions/tool-search/tool.ts
 *
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** Searchable metadata. Domain-specific vocabulary belongs to the caller. */
export interface SearchDocument {
  readonly id: string;
  readonly name: string;
  readonly text?: string;
  readonly context?: string;
}

export interface SearchMatch {
  readonly id: string;
  readonly score: number;
  /** Whole query equals the document's Unicode name or ID, ignoring case/outer whitespace. */
  readonly exact: boolean;
  /** Number of distinct query terms matched in any field. */
  readonly matchedTerms: number;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const stopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  const normalized = text.normalize("NFC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ");
  const words = /^[a-z0-9 ]*$/.test(normalized)
    ? normalized.split(" ")
    : Array.from(segmenter.segment(normalized), word => word.isWordLike ? word.segment : "");
  return words.filter(word => word && !stopWords.has(word)).map(singular);
}

function exactText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

function indexDocument(document: SearchDocument) {
  const frequencies = new Map<string, number>();
  const textTerms = tokenize(document.text ?? "");
  for (const term of textTerms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return {
    document,
    nameTerms: new Set(tokenize(`${document.name} ${document.id}`)),
    contextTerms: new Set(tokenize(document.context ?? "")),
    frequencies,
    length: textTerms.length,
  };
}

/**
 * Rank metadata by exact name/ID, distinct query terms matched, then BM25 relevance.
 * Names/IDs weigh 3 and shared context 0.5; BM25 normalizes only description length.
 * Ties retain input order. Returns every match so callers own totals and pagination;
 * any matching query term qualifies, with more matched terms ranked first.
 * Empty or unmatched queries return []. No persistent index or input mutation.
 *
 * Uses the field-ranking approach of Pi 1.5.0's tool search:
 * https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/extensions/tool-search/tool.ts
 */
export function rankDocuments(query: string, documents: readonly SearchDocument[]): SearchMatch[] {
  const normalizedQuery = exactText(query);
  if (!normalizedQuery || !documents.length) return [];
  const terms = [...new Set(tokenize(query))];

  const indexed = documents.map(indexDocument);
  const averageLength = indexed.reduce((sum, doc) => sum + doc.length, 0) / indexed.length || 1;
  const inverseFrequencies = new Map(terms.map(term => {
    const count = indexed.filter(doc => doc.nameTerms.has(term)
      || doc.contextTerms.has(term) || doc.frequencies.has(term)).length;
    return [term, Math.log(1 + (indexed.length - count + 0.5) / (count + 0.5))];
  }));
  const matches: SearchMatch[] = [];
  for (const doc of indexed) {
    const exact = normalizedQuery === exactText(doc.document.name) || normalizedQuery === exactText(doc.document.id);
    const lengthNorm = 1.2 * (0.25 + 0.75 * doc.length / averageLength);
    let covered = 0;
    let score = 0;
    for (const term of terms) {
      const frequency = doc.frequencies.get(term) ?? 0;
      const weight = (doc.nameTerms.has(term) ? 3 : 0)
        + (doc.contextTerms.has(term) ? 0.5 : 0)
        + frequency * 2.2 / (frequency + lengthNorm);
      if (weight > 0) covered++;
      score += inverseFrequencies.get(term)! * weight;
    }
    if (covered || exact) matches.push({
      id: doc.document.id,
      score,
      matchedTerms: covered,
      exact,
    });
  }
  matches.sort((left, right) => Number(right.exact) - Number(left.exact)
    || right.matchedTerms - left.matchedTerms || right.score - left.score);
  return matches;
}
