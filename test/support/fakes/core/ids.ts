/**
 * Deterministic identifiers for records a fake creates. Fixture records keep
 * their own ids; new ones are numbered per prefix, so a scripted run always
 * produces the same ids (`re_RD0001`, `r-RD0001`, ...).
 */
export class IdSequence {
  private readonly counters = new Map<string, number>();

  /** The next id for a prefix, e.g. next("re_") -> "re_RD0001". */
  next(prefix: string): string {
    const value = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, value);
    return `${prefix}RD${String(value).padStart(4, "0")}`;
  }

  /** The next number of a numeric sequence that starts after `floor`. */
  nextNumber(name: string, floor: number): number {
    const value = Math.max(this.counters.get(name) ?? floor, floor) + 1;
    this.counters.set(name, value);
    return value;
  }
}

/** A request id in the style of each provider, numbered per fake. */
export function requestIdFactory(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `${prefix}${String(count).padStart(8, "0")}`;
  };
}
