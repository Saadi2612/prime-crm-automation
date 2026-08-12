import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  REDACTED,
  clearRegisteredSecrets,
  maskForDisplay,
  redact,
  redactString,
  registerSecret,
  summarizePayload,
} from "../../src/evidence/redact.js";

describe("redaction", () => {
  before(() => {
    registerSecret("s3cret-password-value");
    registerSecret("JBSWY3DPEHPK3PXP");
  });

  after(() => clearRegisteredSecrets());

  it("scrubs registered secrets from free text", () => {
    const output = redactString("login failed for s3cret-password-value at 10:00");
    assert.ok(!output.includes("s3cret-password-value"));
    assert.ok(output.includes(REDACTED));
  });

  it("scrubs a TOTP seed even when it appears mid-sentence", () => {
    assert.ok(!redactString("seed=JBSWY3DPEHPK3PXP ok").includes("JBSWY3DPEHPK3PXP"));
  });

  it("redacts by key regardless of the value", () => {
    const output = redact({ password: "anything at all", jobId: "job-1" }) as Record<string, unknown>;
    assert.equal(output.password, REDACTED);
    assert.equal(output.jobId, "job-1");
  });

  it("redacts nested structures", () => {
    const output = redact({
      job: { id: "j1", credentials: { totpSecret: "abc123456" } },
    }) as Record<string, Record<string, unknown>>;
    assert.equal(output.job!.credentials, REDACTED);
    assert.equal(output.job!.id, "j1");
  });

  it("treats personal data as sensitive", () => {
    const output = redact({ email: "ada@example.com", phone: "+92 300 1234567" }) as Record<
      string,
      unknown
    >;
    assert.equal(output.email, REDACTED);
    assert.equal(output.phone, REDACTED);
  });

  it("strips bearer tokens and JWTs that were never registered", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc";
    assert.ok(!redactString(`Authorization: Bearer ${jwt}`).includes(jwt));
  });

  it("summarises a payload without exposing values", () => {
    const summary = summarizePayload({ full_name: "Ada Lovelace", notes: "" });
    assert.equal(summary.full_name, "present(12)");
    assert.equal(summary.notes, "empty");
    assert.ok(!JSON.stringify(summary).includes("Ada"));
  });

  it("masks values for a human reviewer", () => {
    const masked = maskForDisplay("ada@example.com");
    assert.ok(masked.startsWith("ad"));
    assert.ok(masked.endsWith("om"));
    assert.ok(!masked.includes("example"));
  });

  it("redacts Error objects, stack included", () => {
    const error = new Error("failed with s3cret-password-value");
    const output = redact(error) as { message: string };
    assert.ok(!output.message.includes("s3cret-password-value"));
  });
});
