/**
 * Redaction.
 *
 * The rule this package follows: **log identifiers, not payloads.** A job id,
 * an idempotency key and a field name are safe. A password, a TOTP seed, a
 * session token, or a lead's phone number are not.
 *
 * Two layers, because either alone fails:
 *
 *  1. Key-based — anything under a sensitive key is replaced, whatever it holds.
 *     Catches secrets in shapes we did not anticipate.
 *  2. Value-based — known secret values (read from the environment at startup)
 *     are scrubbed from free text, so a secret that leaks into an error message
 *     or a page snippet still does not reach the log.
 */

export const REDACTED = "[redacted]";

/**
 * Anchored to the whole key rather than matching substrings. A loose pattern
 * looks safer but is not: matching bare "session" or "access" swallows
 * `sessionReused` and `accessCount`, and redacting your own metrics is how
 * observability quietly dies. Sensitive keys are enumerated instead.
 */
const SENSITIVE_KEY_PATTERN = new RegExp(
  `^(${[
    "password",
    "passwd",
    "[a-z_]*secret",
    "[a-z_]*token",
    "[a-z_]*seed",
    "totp",
    "otp",
    "authorization",
    "cookie",
    "cookies",
    "credential[a-z]*",
    "api_?key",
    "storage_?state",
    "email",
    "phone",
    "full_?name",
    "notes",
  ].join("|")})$`,
  "i",
);

/** Values registered here are scrubbed from every string this module touches. */
const secretValues = new Set<string>();

/**
 * Register a literal secret so it can never appear in output. Call once at
 * startup with each credential. Very short values are ignored — scrubbing a
 * 3-character string would mangle unrelated text.
 */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secretValues.add(value);
}

export function clearRegisteredSecrets(): void {
  secretValues.clear();
}

/** Remove any registered secret from a string, plus common inline token shapes. */
export function redactString(input: string): string {
  let output = input;

  for (const secret of secretValues) {
    output = output.replaceAll(secret, REDACTED);
  }

  // Bearer tokens and JWTs that were never registered (e.g. minted at runtime).
  output = output.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
  output = output.replace(/\beyJ[A-Za-z0-9._-]{10,}/g, REDACTED);

  return output;
}

/**
 * Deep-redact a value for logging. Objects are walked; sensitive keys are
 * replaced wholesale; every surviving string is scrubbed for secret values.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max depth]";

  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1);
    }
    return output;
  }

  return String(value);
}

/**
 * Safe summary of a payload: which fields are present and how long each value
 * is, never the values themselves. This is what gets logged instead of a lead.
 */
export function summarizePayload(payload: Record<string, unknown>): Record<string, string> {
  const summary: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || value === "") {
      summary[key] = "empty";
    } else {
      summary[key] = `present(${String(value).length})`;
    }
  }
  return summary;
}

/** Mask a value for a human reviewer: enough to recognise, not enough to leak. */
export function maskForDisplay(value: string): string {
  if (value.length <= 4) return REDACTED;
  return `${value.slice(0, 2)}${"*".repeat(Math.min(value.length - 4, 8))}${value.slice(-2)}`;
}
