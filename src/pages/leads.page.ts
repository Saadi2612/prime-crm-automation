import type { Page } from "@playwright/test";

import { config } from "../config/index.js";
import { AmbiguousWriteError, InfrastructureError, SelectorBreakError } from "../jobs/errors.js";
import type { LeadPayload } from "../validate/schema.js";
import { BasePage } from "./base.page.js";

export interface ExistingLead {
  id: string;
  name: string;
}

export interface WriteResult {
  leadId: string | null;
  confirmed: boolean;
}

/**
 * The leads screen: search (used for the pre-write duplicate check) and the
 * create-lead dialog (the one irreversible action this harness performs).
 */
export class LeadsPage extends BasePage {
  constructor(page: Page, step = "write") {
    super(page, step);
  }

  async open(): Promise<void> {
    await this.goto("/leads");
    await this.requireTestId("add-lead-button");
    // The board is client-rendered. Interacting before the bundle has loaded
    // hits buttons whose handlers are not attached yet.
    await this.page
      .waitForLoadState("load", { timeout: config.stepTimeoutMs })
      .catch(() => undefined);
  }

  /**
   * Second idempotency check: ask the CRM itself whether this lead already
   * exists. The local database only knows about writes this harness made — a
   * record created by a person, or by a previous install, is invisible to it.
   * Without this check "exactly one write" only holds for one copy of the tool.
   */
  async findExistingLead(fullName: string): Promise<ExistingLead | null> {
    const search = await this.requireTestId("leads-search");
    await search.fill(fullName);

    // The search input is debounced at 400ms in the CRM; wait past that, then
    // let the result set settle.
    await this.page.waitForTimeout(900);

    const cards = this.page.locator('[data-testid="lead-card"], [data-testid="lead-row"]');

    try {
      await this.page.waitForLoadState("networkidle", { timeout: config.stepTimeoutMs });
    } catch {
      // A busy app never reaches networkidle; the count below is still valid.
    }

    const count = await cards.count();
    for (let index = 0; index < count; index += 1) {
      const card = cards.nth(index);
      const name = (await card.getAttribute("data-lead-name")) ?? "";
      if (name.trim().toLowerCase() === fullName.trim().toLowerCase()) {
        return { id: (await card.getAttribute("data-lead-id")) ?? "", name: name.trim() };
      }
    }

    return null;
  }

  /**
   * Open the create-lead dialog.
   *
   * The click is retried because a click that lands before hydration does
   * nothing at all — no error, no dialog. That retry is only acceptable because
   * opening a dialog has no side effect and the trigger sets state rather than
   * toggling it; the submit step gets no such treatment.
   */
  async openCreateDialog(): Promise<void> {
    const dialog = this.testId("lead-form").first();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.clickTestId("add-lead-button");
      try {
        await dialog.waitFor({ state: "visible", timeout: 5_000 });
        return;
      } catch {
        // Fall through and click again.
      }
    }

    throw new SelectorBreakError(this.step, "lead-form", { url: this.page.url() });
  }

  /** Fill the form. Every field is optional except the name. */
  async fillLeadForm(payload: LeadPayload): Promise<void> {
    await this.fillTestId("lead-full-name", payload.full_name);

    if (payload.email) await this.fillTestId("lead-email", payload.email);
    if (payload.phone) await this.fillTestId("lead-phone", payload.phone);
    if (payload.job_title) await this.fillTestId("lead-job-title", payload.job_title);
    if (payload.min_budget != null) {
      await this.fillTestId("lead-min-budget", String(payload.min_budget));
    }
    if (payload.max_budget != null) {
      await this.fillTestId("lead-max-budget", String(payload.max_budget));
    }
    if (payload.notes) await this.fillTestId("lead-notes", payload.notes);
  }

  /**
   * Submit the form — the point of no return.
   *
   * Everything before this is repeatable. Everything after has to reason about
   * a side effect that may or may not have happened. The three outcomes are
   * kept strictly apart:
   *
   *   dialog closed + no error   → written (confirmed)
   *   inline field error visible → rejected, nothing written (APP_ERROR)
   *   neither, before timeout    → unknown. AmbiguousWriteError, never a retry.
   */
  async submitLead(fullName: string): Promise<WriteResult> {
    const dialog = this.page.locator('[data-testid="lead-dialog"]').first();
    const fieldError = this.page.locator(
      '[data-testid="lead-error-full-name"], [data-testid="lead-error-email"], [data-testid="lead-error-max-budget"]',
    ).first();

    await this.clickTestId("lead-submit");

    try {
      await Promise.race([
        dialog.waitFor({ state: "detached", timeout: config.stepTimeoutMs }),
        dialog.waitFor({ state: "hidden", timeout: config.stepTimeoutMs }),
        fieldError.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
      ]);
    } catch (cause) {
      // The click landed and nothing observable followed. The server may have
      // created the lead. This must not be retried.
      throw new AmbiguousWriteError(
        this.step,
        "Submitted the lead form but could not read a confirmation before the timeout",
        { fullName, url: this.page.url(), cause: String(cause) },
      );
    }

    if (await fieldError.isVisible().catch(() => false)) {
      const message = ((await fieldError.textContent()) ?? "").trim();
      throw this.applicationError(`The lead form was rejected: ${message}`, { field: true });
    }

    // The dialog closed, so the write went through. Resolve the id by looking
    // the record back up; failing to find it does not undo the write, so an
    // unresolvable id is still ambiguous, not a failure.
    const existing = await this.findExistingLead(fullName).catch(() => null);
    if (!existing) {
      throw new AmbiguousWriteError(
        this.step,
        "The create dialog closed but the new lead could not be located afterwards",
        { fullName, url: this.page.url() },
      );
    }

    return { leadId: existing.id, confirmed: true };
  }

  /**
   * Reconciliation for a job already recorded as `submitted`: did that write
   * land? Used after a crash, and after an ambiguous outcome.
   */
  async reconcile(fullName: string): Promise<ExistingLead | null> {
    try {
      await this.open();
    } catch (error) {
      throw new InfrastructureError("reconcile", "Could not open the leads page to reconcile", {
        cause: error,
      });
    }
    return this.findExistingLead(fullName);
  }
}
