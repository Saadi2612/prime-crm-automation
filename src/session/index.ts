import type { Browser, BrowserContext, Page } from "@playwright/test";

import { config, credentialKey, type Credentials } from "../config/index.js";
import type { Logger } from "../evidence/logger.js";
import { LoginPage } from "../pages/login.page.js";
import { acquireSessionLock, type SessionLock } from "./lock.js";
import {
  discardStoredSession,
  ensureStateDir,
  protectSessionFile,
  readStoredSession,
  sessionPath,
} from "./storage.js";

/**
 * Session management.
 *
 * The rule this module exists to enforce: **never trust a saved session, verify
 * it.** An expiry timestamp is a claim about the past — the token could have
 * been revoked, the password changed, the user deactivated, the tenant
 * suspended. The only honest test is to load the state, hit an authenticated
 * page, and look for something only a logged-in user can see.
 *
 * So each run does exactly this:
 *
 *   1. take the lock for this credential set (one live session per user)
 *   2. if a saved state exists, open it and probe an authenticated element
 *   3. probe passed → reuse. Probe failed → discard, log in fully, save.
 *
 * A failed probe is normal, not an error. It costs one page load to find out,
 * which is far cheaper than a half-completed job against a dead session.
 */

/** The element that proves we are authenticated. Present only inside the app shell. */
const AUTH_PROBE_TESTID = "app-sidebar";

export interface SessionHandle {
  context: BrowserContext;
  page: Page;
  reusedSession: boolean;
  usedTotp: boolean;
  /**
   * True when this harness started the Playwright trace on the context, and so
   * is the one responsible for stopping it. False when something else already
   * had tracing running (the Playwright test runner's own artifacts mode).
   */
  traceOwned?: boolean;
  /** Persist the current cookies/localStorage, then release the credential lock. */
  close: () => Promise<void>;
}

export interface SessionOptions {
  logger: Logger;
  /** Force a fresh login even if a stored session would have passed the probe. */
  forceLogin?: boolean;
  /** Wait this long for the credential lock before giving up. */
  lockTimeoutMs?: number;
}

async function newContext(
  browser: Browser,
  storageStateFile: string | undefined,
): Promise<BrowserContext> {
  return browser.newContext({
    storageState: storageStateFile,
    baseURL: config.baseUrl,
  });
}

/**
 * Load an authenticated page and check it really is authenticated.
 * Returns false for any reason at all — the point is to be cheap and certain,
 * not to explain why the session died.
 */
async function probeAuthenticated(page: Page, logger: Logger): Promise<boolean> {
  try {
    await page.goto(`${config.baseUrl}/leads`, {
      waitUntil: "domcontentloaded",
      timeout: config.stepTimeoutMs,
    });

    await page
      .locator(`[data-testid="${AUTH_PROBE_TESTID}"]`)
      .first()
      .waitFor({ state: "visible", timeout: config.stepTimeoutMs });

    // A redirect to /login with the shell somehow still mounted would be a
    // false positive; check the URL as well.
    if (page.url().includes("/login")) {
      logger.debug({ step: "session.probe" }, "Stored session redirected to login");
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export async function openSession(
  browser: Browser,
  credentials: Credentials,
  options: SessionOptions,
): Promise<SessionHandle> {
  const { logger } = options;
  const key = credentialKey(credentials);

  ensureStateDir();

  const lock: SessionLock = await acquireSessionLock(key, {
    timeoutMs: options.lockTimeoutMs ?? 60_000,
  });
  logger.debug({ step: "session.lock", credentialKey: key }, "Acquired session lock");

  const statePath = sessionPath(credentials);

  // Tracked so a failure can still be photographed before the context dies.
  let failedPage: Page | undefined;

  const finish = async (
    context: BrowserContext,
    page: Page,
    reusedSession: boolean,
    usedTotp: boolean,
  ): Promise<SessionHandle> => ({
    context,
    page,
    reusedSession,
    usedTotp,
    close: async () => {
      try {
        await context.storageState({ path: statePath });
        protectSessionFile(statePath);
      } catch (error) {
        logger.warn(
          { step: "session.persist", error: String(error) },
          "Could not persist the session state",
        );
      } finally {
        await context.close().catch(() => undefined);
        lock.release();
      }
    },
  });

  try {
    // ── 1. Try the stored session, if we are allowed to ──────────────────
    const stored = options.forceLogin ? undefined : readStoredSession(credentials);

    if (stored) {
      const context = await newContext(browser, stored);
      const page = await context.newPage();
      failedPage = page;

      if (await probeAuthenticated(page, logger)) {
        logger.info(
          { step: "session.reuse", credentialKey: key },
          "Reused the stored session (probe passed)",
        );
        return await finish(context, page, true, false);
      }

      logger.info(
        { step: "session.reuse", credentialKey: key },
        "Stored session failed the auth probe; falling back to a full login",
      );
      await context.close().catch(() => undefined);
      discardStoredSession(credentials);
    }

    // ── 2. Full login ────────────────────────────────────────────────────
    const context = await newContext(browser, undefined);
    const page = await context.newPage();
    failedPage = page;

    const login = new LoginPage(page);
    const { usedTotp } = await login.signIn(credentials);

    logger.info(
      { step: "session.login", credentialKey: key, usedTotp },
      "Completed a full login",
    );

    return await finish(context, page, false, usedTotp);
  } catch (error) {
    lock.release();
    // Attach the page that failed so the caller can still photograph it. A
    // login failure with no screenshot is the least diagnosable failure there
    // is, and closing the context here would guarantee exactly that.
    if (error instanceof Error && failedPage && !failedPage.isClosed()) {
      Object.assign(error, { page: failedPage });
    }
    throw error;
  }
}
