import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticator, totp } from "otplib";

/**
 * Client-side TOTP generation.
 *
 * The authoritative skew/replay/backup-code tests live on the server, in
 * `prime-crm-be/authentication/tests.py` — that is where the decisions are
 * made. What matters here is narrower: the harness must generate a code the
 * server will accept, and must understand the step boundary it is generating
 * against, because submitting a code milliseconds before it expires is how a
 * login intermittently fails at 3am.
 */
describe("TOTP code generation", () => {
  const secret = "JBSWY3DPEHPK3PXP";

  it("generates a 6-digit numeric code", () => {
    const code = authenticator.generate(secret);
    assert.match(code, /^\d{6}$/);
  });

  it("verifies its own code", () => {
    assert.equal(authenticator.check(authenticator.generate(secret), secret), true);
  });

  it("uses 30-second steps, matching the server", () => {
    assert.equal(authenticator.options.step ?? 30, 30);
    const remaining = authenticator.timeRemaining();
    assert.ok(remaining > 0 && remaining <= 30, `timeRemaining was ${remaining}`);
  });

  it("produces a different code in the next step", () => {
    const now = Date.now();
    const generator = totp.clone();

    generator.options = { epoch: now };
    const current = generator.generate(secret);

    generator.options = { epoch: now + 30_000 };
    const next = generator.generate(secret);

    assert.notEqual(current, next);
  });

  it("produces the same code twice inside one step — which is why replay defence is server-side", () => {
    const epoch = 1_700_000_000_000;
    const generator = totp.clone();

    generator.options = { epoch };
    const first = generator.generate(secret);

    generator.options = { epoch: epoch + 1_000 };
    const second = generator.generate(secret);

    assert.equal(first, second);
  });

  it("rejects a code from a distant step", () => {
    const generator = totp.clone();
    generator.options = { epoch: Date.now() - 5 * 60_000 };
    const stale = generator.generate(secret);
    assert.equal(authenticator.check(stale, secret), false);
  });
});
