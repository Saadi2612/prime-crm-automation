import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  IllegalTransitionError,
  assertTransition,
  canTransition,
  isTerminal,
  needsHuman,
} from "../../src/jobs/state-machine.js";
import { canonicalize, idempotencyKey, shortKey } from "../../src/jobs/idempotency.js";
import { backoffDelay } from "../../src/jobs/retry.js";
import {
  ApplicationError,
  InfrastructureError,
  SelectorBreakError,
  classifyUnknownError,
} from "../../src/jobs/errors.js";

describe("job state machine", () => {
  it("walks the happy path", () => {
    assert.ok(canTransition("queued", "running"));
    assert.ok(canTransition("running", "submitted"));
    assert.ok(canTransition("submitted", "confirmed"));
  });

  it("never allows a submitted job back into running", () => {
    // The single most important rule here: once the side effect may have
    // happened, the job cannot re-enter the path that causes it.
    assert.equal(canTransition("submitted", "running"), false);
    assert.equal(canTransition("submitted", "queued"), false);
    assert.throws(() => assertTransition("submitted", "running"), IllegalTransitionError);
  });

  it("resolves an ambiguous submission only to confirmed or dead_letter", () => {
    assert.ok(canTransition("submitted", "confirmed"));
    assert.ok(canTransition("submitted", "dead_letter"));
    assert.equal(canTransition("submitted", "failed"), false);
  });

  it("lets an approved review resume at the write", () => {
    assert.ok(canTransition("awaiting_review", "queued"));
    assert.ok(canTransition("awaiting_review", "failed"));
  });

  it("treats confirmed as final", () => {
    assert.ok(isTerminal("confirmed"));
    assert.equal(canTransition("confirmed", "queued"), false);
  });

  it("flags the states that need a person", () => {
    assert.ok(needsHuman("awaiting_review"));
    assert.ok(needsHuman("dead_letter"));
    assert.equal(needsHuman("running"), false);
  });
});

describe("idempotency key", () => {
  it("ignores key order", () => {
    assert.equal(
      canonicalize({ a: "1", b: "2" }),
      canonicalize({ b: "2", a: "1" }),
    );
  });

  it("normalises whitespace and case", () => {
    assert.equal(
      idempotencyKey("acme", { full_name: "Ada  Lovelace " }),
      idempotencyKey("acme", { full_name: "ada lovelace" }),
    );
  });

  it("drops empty values so absent and blank agree", () => {
    assert.equal(
      idempotencyKey("acme", { full_name: "Ada", notes: "" }),
      idempotencyKey("acme", { full_name: "Ada" }),
    );
  });

  it("changes when the data changes", () => {
    assert.notEqual(
      idempotencyKey("acme", { full_name: "Ada" }),
      idempotencyKey("acme", { full_name: "Grace" }),
    );
  });

  it("separates tenants", () => {
    assert.notEqual(
      idempotencyKey("acme", { full_name: "Ada" }),
      idempotencyKey("globex", { full_name: "Ada" }),
    );
  });

  it("shortens for display without colliding trivially", () => {
    const key = idempotencyKey("acme", { full_name: "Ada" });
    assert.equal(shortKey(key).length, 12);
  });
});

describe("error classification", () => {
  it("treats a timeout as infrastructure", () => {
    const error = classifyUnknownError("open", new Error("Timeout 15000ms exceeded"));
    assert.equal(error.category, "INFRA");
    assert.equal(error.retryable, true);
  });

  it("treats a connection reset as infrastructure", () => {
    const error = classifyUnknownError("open", new Error("net::ERR_CONNECTION_REFUSED"));
    assert.equal(error.category, "INFRA");
  });

  it("never marks a selector break retryable", () => {
    const error = new SelectorBreakError("write", "lead-submit");
    assert.equal(error.category, "SELECTOR_BREAK");
    assert.equal(error.retryable, false);
  });

  it("never marks an application rejection retryable", () => {
    const error = new ApplicationError("write", "Full name is required");
    assert.equal(error.retryable, false);
  });

  it("passes an already-classified error through unchanged", () => {
    const original = new InfrastructureError("open", "boom");
    assert.equal(classifyUnknownError("other", original), original);
  });
});

describe("backoff", () => {
  it("grows exponentially", () => {
    const first = backoffDelay(1, 500);
    const third = backoffDelay(3, 500);
    assert.ok(third > first, `${third} should exceed ${first}`);
  });

  it("stays bounded", () => {
    assert.ok(backoffDelay(20, 500) <= 30_000);
  });

  it("includes jitter, so parallel runs do not resynchronise", () => {
    const samples = new Set(Array.from({ length: 25 }, () => backoffDelay(3, 500)));
    assert.ok(samples.size > 1);
  });
});
