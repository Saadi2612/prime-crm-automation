import fs from "node:fs";
import path from "node:path";

import { config, credentialKey, type Credentials } from "../config/index.js";

/**
 * Where a session lives on disk.
 *
 * One file per (tenant, user). Keying by tenant is not cosmetic: the CRM
 * resolves the tenant from the hostname, so a session for `acme.localhost` is
 * meaningless — and dangerous to reuse — on `globex.localhost`. Separate files
 * make cross-tenant reuse structurally impossible rather than merely discouraged.
 *
 * These files contain live session tokens. They are gitignored, and written
 * 0600 so other users on the machine cannot read them.
 */

export function sessionPath(credentials: Pick<Credentials, "tenant" | "email">): string {
  return path.join(config.stateDir, `session-${credentialKey(credentials)}.json`);
}

export function hasStoredSession(credentials: Pick<Credentials, "tenant" | "email">): boolean {
  return fs.existsSync(sessionPath(credentials));
}

export function readStoredSession(
  credentials: Pick<Credentials, "tenant" | "email">,
): string | undefined {
  const file = sessionPath(credentials);
  return fs.existsSync(file) ? file : undefined;
}

export function discardStoredSession(
  credentials: Pick<Credentials, "tenant" | "email">,
): void {
  const file = sessionPath(credentials);
  try {
    fs.unlinkSync(file);
  } catch {
    /* nothing to discard */
  }
}

export function ensureStateDir(): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
}

/** Tighten permissions on a storageState file Playwright just wrote. */
export function protectSessionFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort: some filesystems do not support it */
  }
}
