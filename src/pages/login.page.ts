import type { Page } from "@playwright/test";
import { authenticator } from "otplib";

import { config } from "../config/index.js";
import type { Credentials } from "../config/index.js";
import { ApplicationError, InfrastructureError } from "../jobs/errors.js";
import { BasePage } from "./base.page.js";

/**
 * Login, including the TOTP step.
 *
 * The password and the seed arrive as arguments and are used inline; neither is
 * stored on the object, and neither is ever passed to the logger.
 */
export class LoginPage extends BasePage {
  constructor(page: Page) {
    super(page, "login");
  }

  async open(): Promise<void> {
    await this.goto("/login");
    await this.requireTestId("login-form");
    // The form is client-rendered; typing into it before the bundle has loaded
    // gets the input reset out from under us.
    await this.page
      .waitForLoadState("load", { timeout: config.stepTimeoutMs })
      .catch(() => undefined);
  }

  /**
   * Complete a full login. Returns whether a TOTP challenge was involved, which
   * the caller records as evidence that 2FA is actually in the path.
   */
  async signIn(credentials: Credentials): Promise<{ usedTotp: boolean }> {
    await this.open();

    await this.fillTestId("login-email", credentials.email);
    await this.fillTestId("login-password", credentials.password);
    await this.clickTestId("login-submit");

    const challenged = await this.waitForPasswordOutcome();

    if (!challenged) return { usedTotp: false };

    await this.submitTotpCode(credentials.totpSecret);
    return { usedTotp: true };
  }

  /**
   * After submitting the password, exactly one of three things happens: the 2FA
   * page appears, the dashboard appears, or the app rejects the credentials.
   * Race them rather than waiting on one and timing out on the others, so a
   * rejected password surfaces as an APP_ERROR instead of a timeout.
   */
  private async waitForPasswordOutcome(): Promise<boolean> {
    const totpForm = this.page.locator('[data-testid="totp-form"]').first();
    const sidebar = this.page.locator('[data-testid="app-sidebar"]').first();
    const toast = this.page.locator("[data-sonner-toast]").first();

    try {
      await Promise.race([
        totpForm.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
        sidebar.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
        toast.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
      ]);
    } catch (error) {
      throw new InfrastructureError(
        this.step,
        "No response to the password submission before the timeout",
        { cause: error },
      );
    }

    if (await totpForm.isVisible().catch(() => false)) return true;
    if (await sidebar.isVisible().catch(() => false)) return false;

    // Only a rejection toast is left: the application refused the credentials.
    const message = ((await toast.textContent().catch(() => null)) ?? "").trim();
    throw new ApplicationError(this.step, `Login was rejected by the application: ${message}`, {
      url: this.page.url(),
    });
  }

  /**
   * Generate and submit a TOTP code.
   *
   * If the current code is close to expiring, wait for the next step instead of
   * submitting one that will be stale by the time the server checks it. The
   * server accepts one step of skew, so this is belt-and-braces, but a code
   * generated at the boundary is also a code that can be rejected as a replay
   * on a retry — waiting is cheaper than diagnosing that.
   */
  async submitTotpCode(secret: string): Promise<void> {
    await this.requireTestId("totp-form");

    if (authenticator.timeRemaining() < 3) {
      await this.page.waitForTimeout((authenticator.timeRemaining() + 1) * 1000);
    }

    const code = authenticator.generate(secret);

    await this.fillTestId("totp-code", code);
    await this.clickTestId("totp-submit");

    const error = this.page.locator('[data-testid="totp-error"]').first();
    const sidebar = this.page.locator('[data-testid="app-sidebar"]').first();

    try {
      await Promise.race([
        sidebar.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
        error.waitFor({ state: "visible", timeout: config.stepTimeoutMs }),
      ]);
    } catch (cause) {
      throw new InfrastructureError(this.step, "No response to the TOTP submission", { cause });
    }

    if (await error.isVisible().catch(() => false)) {
      const message = ((await error.textContent()) ?? "").trim();
      throw new ApplicationError(this.step, `TOTP verification failed: ${message}`, {
        url: this.page.url(),
      });
    }
  }
}
