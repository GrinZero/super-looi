export function assert(
  value: unknown,
  message = "assertion failed",
): asserts value {
  if (!value) throw new Error(message);
}
export function equal(
  actual: unknown,
  expected: unknown,
  message = "values differ",
) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
}
export function throws(fn: () => unknown, includes?: string) {
  try {
    fn();
  } catch (e) {
    if (includes) assert(String(e).includes(includes), String(e));
    return;
  }
  throw new Error("expected an exception");
}
