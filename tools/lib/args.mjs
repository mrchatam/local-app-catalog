/**
 * Shared argument validation for the Node CLIs.
 *
 * Every tool here parses `--flag value` pairs by hand, and each one used to do
 * it slightly differently. The bug that found this file is the classic one: a
 * flag that takes `argv[++i]` blindly swallows the *next* flag as its value, so
 *
 *   node tools/validate/cli.mjs --country --json
 *
 * validated the country "--json" and printed the human report instead of JSON,
 * while `node tools/build/cli.mjs --out --quiet` happily wrote a release into a
 * directory literally named `--quiet`. `need()` and `needInt()` are the single
 * place that rule lives now, so validate, build, recheck and curate cannot drift
 * apart again.
 *
 * A UsageError means the command line was wrong. Callers map it to their own
 * usage exit code (3, except the Python entry points which use 2) and never to
 * a data-problem code: exit 1 and 2 mean "the catalog has a finding" and must
 * not be reachable by a typo.
 */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Run a parsing/validation step, turning a UsageError into the caller's usage
 * exit: usage text, the message, and a code that can never be confused with
 * "the catalog has a finding".
 */
export function usageGuard(usage, exitCode, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${usage}\n${err.message}`);
      process.exit(exitCode);
    }
    throw err;
  }
}

/**
 * The value that follows a flag. Rejects a missing value, and rejects the next
 * flag masquerading as one - `--out --quiet` is a mistake, never a request to
 * write into a directory named `--quiet`.
 */
export function need(flag, raw) {
  if (raw === undefined || raw.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return raw;
}

/**
 * need() plus a bounds-checked integer. `--max-messages abc` used to parse to
 * NaN, which silently disabled the cap instead of complaining.
 *
 * Uses Number() rather than parseInt() so "12abc" is rejected instead of
 * quietly becoming 12.
 */
export function needInt(flag, raw, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const text = need(flag, raw);
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    const range =
      Number.isFinite(min) && Number.isFinite(max)
        ? `between ${min} and ${max}`
        : Number.isFinite(min)
          ? `at least ${min}`
          : `at most ${max}`;
    throw new UsageError(`${flag} needs an integer ${range}, got "${text}"`);
  }
  return value;
}

/**
 * A two-letter country code the catalog actually registers. `--country XX` used
 * to filter every finding away and exit 0, which reads exactly like a clean run.
 * `known` is the country list from data/index.json; pass it when the caller has
 * a loaded repo and omit it to check only the shape.
 */
export function needCountry(flag, raw, known = null) {
  const code = need(flag, raw).toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new UsageError(`${flag} needs a two-letter country code, got "${raw}"`);
  }
  if (known && !known.map((c) => String(c).toUpperCase()).includes(code)) {
    throw new UsageError(`unknown country: ${code} (registered: ${[...known].map((c) => String(c).toUpperCase()).sort().join(", ")})`);
  }
  return code;
}
