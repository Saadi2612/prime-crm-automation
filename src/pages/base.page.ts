import type { Locator, Page } from "@playwright/test";

import { config } from "../config/index.js";
import {
  ApplicationError,
  InfrastructureError,
  SelectorBreakError,
  classifyUnknownError,
} from "../jobs/errors.js";

/**
 * Base page object.
 *
 * Every element lookup goes through here so the selector-break / app-error /
 * infra distinction is made in exactly one place rather than re-derived at each
 * call site.
 *
 * The distinction is drawn like this: if the element is missing but the page
 * itself responded and rendered, the CRM's markup changed underneath us — a
 * selector break, and retrying it is pointless. If the page never got that far
 * (navigation timeout, dead socket), it is infrastructure, and a retry may
 * genuinely help.
 */
export abstract class BasePage {
  protected constructor(
    readonly page: Page,
    readonly step: string,
  ) {}

  /** All selectors in this package are data-testid. Never CSS classes or text. */
  protected testId(id: string): Locator {
    return this.page.locator(`[data-testid="${id}"]`);
  }

  /** True if the document itself is alive and rendered, whatever is missing from it. */
  protected async pageIsHealthy(): Promise<boolean> {
    try {
      const state = await this.page.evaluate(() => document.readyState);
      return state === "interactive" || state === "complete";
    } catch {
      return false;
    }
  }

  /**
   * Wait for an element, classifying the failure. A missing element on a healthy
   * page is a SELECTOR_BREAK; on an unhealthy page it is INFRA.
   */
  protected async requireTestId(
    id: string,
    options: { timeout?: number; state?: "visible" | "attached" } = {},
  ): Promise<Locator> {
    const locator = this.testId(id);
    try {
      await locator.first().waitFor({
        state: options.state ?? "visible",
        timeout: options.timeout ?? config.stepTimeoutMs,
      });
      return locator.first();
    } catch (error) {
      if (await this.pageIsHealthy()) {
        throw new SelectorBreakError(this.step, id, { url: this.page.url(), cause: error });
      }
      throw new InfrastructureError(
        this.step,
        `Page was not usable while waiting for [data-testid="${id}"]`,
        { cause: error },
      );
    }
  }

  /** Present right now, without waiting long. Used for probes, never assertions. */
  protected async hasTestId(id: string, timeout = 2_000): Promise<boolean> {
    try {
      await this.testId(id).first().waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fill a field and confirm the value actually stuck.
   *
   * Every input in this CRM is a controlled React component. If the field is
   * filled before hydration finishes, the DOM value is set but React's state is
   * not, and the next render wipes it — leaving an empty required field that
   * silently blocks the form from submitting at all. That failure looks exactly
   * like a hung backend, so it is worth the read-back.
   */
  protected async fillTestId(id: string, value: string): Promise<void> {
    const field = await this.requireTestId(id);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await field.fill(value);
      } catch (error) {
        throw classifyUnknownError(this.step, error);
      }

      if ((await field.inputValue().catch(() => null)) === value) return;

      // Hydration landed mid-fill and reset the input. Give React a beat, retry.
      await this.page.waitForTimeout(250);
    }

    throw new InfrastructureError(
      this.step,
      `Value for [data-testid="${id}"] would not persist after three attempts ` +
        `(the field is probably not hydrated yet)`,
    );
  }

  protected async clickTestId(id: string): Promise<void> {
    const element = await this.requireTestId(id);
    try {
      await element.click();
    } catch (error) {
      throw classifyUnknownError(this.step, error);
    }
  }

  protected async goto(pathname: string): Promise<void> {
    try {
      await this.page.goto(`${config.baseUrl}${pathname}`, {
        waitUntil: "domcontentloaded",
        timeout: config.stepTimeoutMs,
      });
    } catch (error) {
      throw new InfrastructureError(this.step, `Navigation to ${pathname} failed`, { cause: error });
    }
  }

  /**
   * Read an error the application rendered. Present means the app rejected our
   * input — an APP_ERROR, distinct from our selectors being wrong.
   */
  protected async readApplicationError(testId: string): Promise<string | null> {
    const locator = this.testId(testId).first();
    try {
      if (await locator.isVisible({ timeout: 1_000 })) {
        return ((await locator.textContent()) ?? "").trim() || null;
      }
    } catch {
      /* absent is the normal case */
    }
    return null;
  }

  protected applicationError(
    message: string,
    details: Record<string, unknown> = {},
  ): ApplicationError {
    return new ApplicationError(this.step, message, { ...details, url: this.page.url() });
  }
}
