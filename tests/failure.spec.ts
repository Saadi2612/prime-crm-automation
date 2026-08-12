import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { createLogger } from "../src/evidence/logger.js";
import { JobRunner } from "../src/jobs/runner.js";
import { LeadsPage } from "../src/pages/leads.page.js";
import { allArtifactFiles, freshStore, leadPayload } from "./helpers.js";

/**
 * Failure handling.
 *
 * The selector-break case is the centrepiece: when the CRM's markup changes
 * under us, the run must fail loudly in the right category, capture enough
 * evidence to fix it, and — the part that actually matters — leave no partial
 * write behind.
 */
test.describe.configure({ mode: "serial" });

test.describe("failure handling", () => {
  test("a missing selector on a healthy page fails as SELECTOR_BREAK and writes nothing", async () => {
    const store = freshStore("selector-break");
    const runner = new JobRunner(store);
    const payload = leadPayload();

    let caught: unknown;
    try {
      await runner.run({
        payload,
        logger: createLogger({ runId: "test-selector-break" }),
        // Point a step at a testid the CRM does not have. The page itself loads
        // perfectly — this is a markup change, not an outage.
        selectorOverrides: { "lead-full-name": "lead-full-name-that-does-not-exist" },
      });
    } catch (error) {
      caught = error;
    } finally {
      runner.close();
    }

    expect(caught).toBeTruthy();
    expect(caught).toMatchObject({ category: "SELECTOR_BREAK" });

    // Categorised correctly, and never retried: a broken selector fails the
    // same way every time, so retrying only delays the report.
    const job = store.list()[0];
    expect(job).toBeTruthy();
    expect(job?.failureCategory).toBe("SELECTOR_BREAK");
    expect(job?.state).toBe("failed");

    // No partial write: the form was never submitted.
    expect(job?.submittedAt).toBeNull();
    expect(job?.resultRef).toBeNull();
    const states = store.history(job!.id).map((t) => t.toState);
    expect(states).not.toContain("submitted");
    expect(states).not.toContain("confirmed");

    // Evidence: screenshot, HTML, metadata and a trace.
    expect(job?.artifactDir).toBeTruthy();
    const files = allArtifactFiles(job!.artifactDir!).map((f) => path.basename(f));
    expect(files.some((f) => f.endsWith(".png"))).toBe(true);
    expect(files.some((f) => f.endsWith(".html"))).toBe(true);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    expect(files).toContain("trace.zip");

    store.close();
  });

  test("the CRM really does still lack that testid, and really does have the right one", async ({
    page,
  }) => {
    // Guards the test above from rotting into a false pass: if the CRM ever
    // ships `lead-full-name-that-does-not-exist`, the selector-break test would
    // silently stop testing anything.
    const { loadCredentials } = await import("../src/config/index.js");
    const { openSession } = await import("../src/session/index.js");
    const { chromium } = await import("@playwright/test");

    const browser = await chromium.launch();
    try {
      const session = await openSession(browser, loadCredentials(), {
        logger: createLogger({ runId: "test-selector-guard" }),
      });
      try {
        const leads = new LeadsPage(session.page);
        await leads.open();
        await leads.openCreateDialog();

        await expect(
          session.page.locator('[data-testid="lead-full-name"]'),
        ).toBeVisible();
        await expect(
          session.page.locator('[data-testid="lead-full-name-that-does-not-exist"]'),
        ).toHaveCount(0);
      } finally {
        await session.close();
      }
    } finally {
      await browser.close();
      await page.close();
    }
  });

  test("a form the application rejects is an APP_ERROR, not a selector break", async () => {
    // The other side of the distinction: the page loaded, every selector
    // resolved, and the application itself refused the input. Driven through
    // the page object directly, because the payload schema catches this case
    // before the browser opens — which is the point: two layers, two categories.
    const { loadCredentials } = await import("../src/config/index.js");
    const { openSession } = await import("../src/session/index.js");
    const { chromium } = await import("@playwright/test");

    const browser = await chromium.launch();
    try {
      const session = await openSession(browser, loadCredentials(), {
        logger: createLogger({ runId: "test-app-error" }),
      });

      try {
        const leads = new LeadsPage(session.page);
        await leads.open();
        await leads.openCreateDialog();

        // max_budget below min_budget: the CRM renders an inline field error.
        await leads.fillLeadForm({
          full_name: `App Error ${Date.now()}`,
          min_budget: 900000,
          max_budget: 1,
        });

        let caught: unknown;
        try {
          await leads.submitLead("never-submitted");
        } catch (error) {
          caught = error;
        }

        expect(caught).toMatchObject({ category: "APP_ERROR" });
        expect((caught as { retryable: boolean }).retryable).toBe(false);

        // The dialog is still open, so nothing was written.
        await expect(session.page.locator('[data-testid="lead-dialog"]')).toBeVisible();
      } finally {
        await session.close();
      }
    } finally {
      await browser.close();
    }
  });

  test("failure evidence contains no secrets", async () => {
    const store = freshStore("redaction");
    const runner = new JobRunner(store);

    try {
      await runner
        .run({
          payload: leadPayload(),
          logger: createLogger({ runId: "test-redaction" }),
          selectorOverrides: { "lead-full-name": "definitely-not-a-real-testid" },
        })
        .catch(() => undefined);
    } finally {
      runner.close();
    }

    const job = store.list()[0];
    const password = process.env.CRM_PASSWORD ?? "";
    const seed = process.env.CRM_TOTP_SECRET ?? "";

    for (const file of allArtifactFiles(job!.artifactDir!)) {
      if (file.endsWith(".zip") || file.endsWith(".png")) continue;
      const contents = fs.readFileSync(file, "utf8");
      if (password) expect(contents).not.toContain(password);
      if (seed) expect(contents).not.toContain(seed);
    }

    store.close();
  });

  test("the run exits non-zero when a job fails", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);

    const inputPath = path.join(process.cwd(), "state", "test-invalid-input.json");
    fs.mkdirSync(path.dirname(inputPath), { recursive: true });
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ payload: { full_name: "", email: "nope" } }),
      "utf8",
    );

    let exitCode = 0;
    try {
      await run("npx", ["tsx", "src/cli.ts", "run", inputPath], { cwd: process.cwd() });
    } catch (error) {
      exitCode = (error as { code?: number }).code ?? 1;
    }

    expect(exitCode).not.toBe(0);
  });
});
