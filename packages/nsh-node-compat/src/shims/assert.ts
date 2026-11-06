export class AssertionError extends Error {
  code = "ERR_ASSERTION";
  actual: unknown;
  expected: unknown;
  operator: string;
  constructor(
    options: {
      message?: string;
      actual?: unknown;
      expected?: unknown;
      operator?: string;
    } = {},
  ) {
    super(options.message ?? "Assertion failed");
    this.name = "AssertionError";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? "==";
  }
}
export function ok(value: unknown, message?: string): asserts value {
  if (!value)
    throw new AssertionError({
      message,
      actual: value,
      expected: true,
      operator: "==",
    });
}
export function strictEqual(
  actual: unknown,
  expected: unknown,
  message?: string,
) {
  if (!Object.is(actual, expected))
    throw new AssertionError({
      actual,
      expected,
      message,
      operator: "strictEqual",
    });
}
export function notStrictEqual(
  actual: unknown,
  expected: unknown,
  message?: string,
) {
  if (Object.is(actual, expected))
    throw new AssertionError({
      actual,
      expected,
      message,
      operator: "notStrictEqual",
    });
}
export function equal(actual: unknown, expected: unknown, message?: string) {
  if (actual != expected)
    throw new AssertionError({ actual, expected, message });
}
export function fail(message?: string): never {
  throw new AssertionError({ message });
}
export function throws(
  fn: () => unknown,
  expected?: RegExp | ((error: unknown) => boolean),
) {
  try {
    fn();
  } catch (error) {
    if (expected instanceof RegExp && !expected.test(String(error)))
      throw error;
    if (typeof expected === "function" && !expected(error)) throw error;
    return;
  }
  fail("Expected an exception");
}
const assert = Object.assign(ok, {
  ok,
  strictEqual,
  notStrictEqual,
  equal,
  fail,
  throws,
  AssertionError,
});
export const strict = assert;
export default assert;
