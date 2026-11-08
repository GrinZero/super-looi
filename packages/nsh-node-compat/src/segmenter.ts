import { call } from "./bridge.js";
/** ICU Unicode segmentation for hosts without Intl.Segmenter. The fallback uses
 * invariant content locale, not locale tailoring; do not claim other Intl APIs. */
export class NshSegmenter {
  private granularity: "grapheme" | "word" | "sentence";
  constructor(
    locales?: string | readonly string[],
    options: { granularity?: "grapheme" | "word" | "sentence" } = {},
  ) {
    if (
      locales !== undefined &&
      !(Array.isArray(locales) && locales.length === 0) &&
      locales !== "und"
    )
      throw new RangeError(
        "NSH fallback Segmenter supports invariant locale only",
      );
    this.granularity = options.granularity ?? "grapheme";
    if (!["grapheme", "word", "sentence"].includes(this.granularity))
      throw new RangeError("Invalid granularity");
  }
  resolvedOptions() {
    return { locale: "und", granularity: this.granularity };
  }
  static supportedLocalesOf() {
    return [];
  }
  segment(value: string) {
    const input = String(value);
    const boundaries = call<
      Array<{ start: number; end: number; isWordLike?: boolean }>
    >("segment", { input, granularity: this.granularity });
    const data = (b: { start: number; end: number; isWordLike?: boolean }) => ({
      segment: input.slice(b.start, b.end),
      index: b.start,
      input,
      ...(this.granularity === "word" ? { isWordLike: b.isWordLike } : {}),
    });
    return {
      *[Symbol.iterator]() {
        for (const b of boundaries) yield data(b);
      },
      containing(index = 0) {
        const n = Math.trunc(Number(index));
        if (!Number.isFinite(n) || n < 0 || n >= input.length) return undefined;
        const b = boundaries.find((b) => b.start <= n && b.end > n);
        return b ? data(b) : undefined;
      },
    };
  }
}
