import fs from "node:fs";
import path from "node:path";

import { config } from "../config/index.js";

/**
 * One concurrent session per credential set.
 *
 * Two jobs logging in as the same user at the same time is not a theoretical
 * problem: both would race on the same `storageState` file, and — worse — a
 * TOTP code is single-use, so the second login can consume the step the first
 * one needs and fail it. The lock makes that impossible.
 *
 * Implemented with `wx` file creation, which is atomic on every platform that
 * matters. The lock holds the owning PID and a timestamp so a crashed run does
 * not wedge the credential forever: a lock whose process is gone, or that is
 * older than the stale timeout, is reclaimed.
 */

export class LockTimeoutError extends Error {
  constructor(key: string, waitedMs: number) {
    super(`Timed out after ${waitedMs}ms waiting for the session lock on ${key}`);
    this.name = "LockTimeoutError";
  }
}

interface LockFile {
  pid: number;
  acquiredAt: string;
  key: string;
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
  pollIntervalMs?: number;
}

export interface SessionLock {
  key: string;
  path: string;
  release: () => void;
}

function lockPath(key: string): string {
  return path.join(config.stateDir, `${key}.lock`);
}

function processAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(file: string): LockFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as LockFile;
  } catch {
    return null;
  }
}

function isStale(lock: LockFile | null, staleMs: number): boolean {
  if (!lock) return true; // unreadable or truncated — a crashed writer
  if (!processAlive(lock.pid)) return true;
  return Date.now() - new Date(lock.acquiredAt).getTime() > staleMs;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireSessionLock(
  key: string,
  options: LockOptions = {},
): Promise<SessionLock> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;

  const file = lockPath(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const startedAt = Date.now();

  for (;;) {
    try {
      const handle = fs.openSync(file, "wx");
      const contents: LockFile = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        key,
      };
      fs.writeFileSync(handle, JSON.stringify(contents));
      fs.closeSync(handle);

      let released = false;
      return {
        key,
        path: file,
        release: () => {
          if (released) return;
          released = true;
          // Only remove the lock if it is still ours — a reclaimed stale lock
          // now belongs to someone else and must not be deleted.
          const current = readLock(file);
          if (current?.pid === process.pid) {
            try {
              fs.unlinkSync(file);
            } catch {
              /* already gone */
            }
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      if (isStale(readLock(file), staleMs)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* another waiter beat us to it */
        }
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new LockTimeoutError(key, Date.now() - startedAt);
      }

      await sleep(pollIntervalMs);
    }
  }
}

/** Run `fn` holding the credential lock, releasing it whatever happens. */
export async function withSessionLock<T>(
  key: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lock = await acquireSessionLock(key, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
