import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

import { config } from "../config/index.js";
import type { Logger } from "./logger.js";
import { redactString } from "./redact.js";

/**
 * Evidence capture.
 *
 * When a run fails at 03:00, the only thing that makes it diagnosable is what
 * was captured at the moment of failure. Four artefacts, because each answers a
 * question the others cannot:
 *
 *   screenshot — what the operator would have seen
 *   HTML       — what the selectors were actually looking at
 *   URL + meta — where we were, and what we were doing
 *   trace      — how we got there, step by step, replayable
 *
 * Success is captured too, deliberately: a confirmation screenshot is the proof
 * that an irreversible write happened, and is what a human compares against
 * when reconciling an ambiguous outcome later.
 *
 * The saved HTML passes through the redactor first. Page markup can contain
 * tokens in inline scripts, and an artifact directory is a file on disk that
 * outlives the run.
 */

export interface ArtifactPaths {
  dir: string;
  screenshot?: string;
  html?: string;
  meta?: string;
  trace?: string;
}

export function runArtifactDir(runId: string, jobId?: string): string {
  return jobId
    ? path.join(config.artifactDir, runId, jobId)
    : path.join(config.artifactDir, runId);
}

export function ensureArtifactDir(runId: string, jobId?: string): string {
  const dir = runArtifactDir(runId, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface CaptureOptions {
  runId: string;
  jobId?: string;
  step: string;
  label: string;
  logger: Logger;
  extra?: Record<string, unknown>;
}

/**
 * Capture the full evidence set. Never throws: a failure to record a failure
 * must not replace the original error with a less useful one.
 */
export async function captureEvidence(
  page: Page | null,
  options: CaptureOptions,
): Promise<ArtifactPaths> {
  const dir = ensureArtifactDir(options.runId, options.jobId);
  const result: ArtifactPaths = { dir };
  const stamp = `${options.label}`;

  if (page && !page.isClosed()) {
    try {
      result.screenshot = path.join(dir, `${stamp}.png`);
      await page.screenshot({ path: result.screenshot, fullPage: true });
    } catch (error) {
      options.logger.warn({ step: options.step, error: String(error) }, "Screenshot failed");
      delete result.screenshot;
    }

    try {
      const html = await page.content();
      result.html = path.join(dir, `${stamp}.html`);
      fs.writeFileSync(result.html, redactString(html), "utf8");
    } catch (error) {
      options.logger.warn({ step: options.step, error: String(error) }, "HTML capture failed");
      delete result.html;
    }
  }

  try {
    result.meta = path.join(dir, `${stamp}.json`);
    fs.writeFileSync(
      result.meta,
      JSON.stringify(
        {
          runId: options.runId,
          jobId: options.jobId,
          step: options.step,
          label: options.label,
          url: page && !page.isClosed() ? page.url() : null,
          capturedAt: new Date().toISOString(),
          ...options.extra,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (error) {
    options.logger.warn({ step: options.step, error: String(error) }, "Metadata capture failed");
    delete result.meta;
  }

  return result;
}

/**
 * Stop the Playwright trace and write it into the artifact directory. Tracing
 * is started by the caller when the context opens, so a trace exists for every
 * run whether or not it ends up failing.
 */
export async function saveTrace(
  context: { tracing: { stop: (options?: { path?: string }) => Promise<void> } },
  runId: string,
  jobId: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  const dir = ensureArtifactDir(runId, jobId);
  const file = path.join(dir, "trace.zip");
  try {
    await context.tracing.stop({ path: file });
    return file;
  } catch (error) {
    logger.warn({ step: "evidence.trace", error: String(error) }, "Could not save the trace");
    return undefined;
  }
}
