import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { config, loadCredentials } from "../src/config/index.js";
import { JobStore } from "../src/jobs/store.js";
import { sessionPath } from "../src/session/storage.js";

/**
 * Test helpers.
 *
 * Every spec gets its own SQLite database and its own state directory, so a
 * test's idempotency behaviour is never an accident of what an earlier test
 * left behind. The one exception is deliberate: the duplicate test reuses a
 * store on purpose, because that is the thing under test.
 */

export function uniqueName(prefix = "Auto"): string {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

export function freshStore(label: string): JobStore {
  const file = path.join(config.stateDir, `test-${label}-${randomUUID().slice(0, 8)}.sqlite`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new JobStore(file);
}

export function leadPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: uniqueName("Lead"),
    email: `lead-${randomUUID().slice(0, 8)}@example.com`,
    phone: "+92 300 1234567",
    job_title: "Buyer",
    min_budget: 100000,
    max_budget: 250000,
    ...overrides,
  };
}

/** Remove the saved session so the next run has to log in from scratch. */
export function clearStoredSession(): void {
  const credentials = loadCredentials();
  try {
    fs.unlinkSync(sessionPath(credentials));
  } catch {
    /* nothing stored */
  }
}

/** Corrupt the saved session so the auth probe fails but the file still exists. */
export function invalidateStoredSession(): void {
  const credentials = loadCredentials();
  const file = sessionPath(credentials);

  const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
    cookies: unknown[];
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };

  // Keep the shape valid — an unparseable file would be rejected by Playwright
  // before the probe ever ran, which is not the scenario under test. A revoked
  // token looks exactly like this: present, well-formed, and useless.
  state.cookies = [];
  for (const origin of state.origins ?? []) {
    origin.localStorage = (origin.localStorage ?? []).map((entry) =>
      entry.name === "crm_access" ? { ...entry, value: "invalidated-by-test" } : entry,
    );
  }

  fs.writeFileSync(file, JSON.stringify(state), "utf8");
}

export function artifactFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Recursively collect every file under a run's artifact directory. */
export function allArtifactFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  try {
    walk(dir);
  } catch {
    /* nothing captured */
  }
  return found;
}
