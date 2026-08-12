import { defineConfig } from "@playwright/test";
import { config as loadDotenv } from "dotenv";

loadDotenv({ quiet: true });

/**
 * The suite drives a real CRM instance, and several cases hinge on shared
 * state: one job's write is the next test's duplicate, and the credential lock
 * exists precisely to stop two logins racing. So: one worker, no test-level
 * retries. A retry here would silently paper over the non-idempotency this
 * package is built to prevent.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.CRM_BASE_URL ?? "http://acme.localhost:3000",
    headless: process.env.HEADLESS !== "false",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // The harness captures its own evidence — screenshot, HTML, URL and trace —
    // into artifacts/<runId>/<jobId>/, and the suite asserts on those files.
    // Leaving the runner's tracing on would start a second trace on the same
    // context, so evidence capture is left entirely to the code under test.
    trace: "off",
    screenshot: "off",
  },
});
