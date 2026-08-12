import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

loadDotenv({ path: path.join(packageRoot, ".env"), quiet: true });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function toInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return parsed;
}

function toFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be a number, got "${raw}"`);
  return parsed;
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.join(packageRoot, value);
}

/**
 * Credentials are read lazily so that commands which never open a browser
 * (`list`, `review`) work without a fully populated .env.
 */
export interface Credentials {
  tenant: string;
  email: string;
  password: string;
  totpSecret: string;
  baseUrl: string;
}

export function loadCredentials(): Credentials {
  const baseUrl = required("CRM_BASE_URL").replace(/\/$/, "");
  return {
    baseUrl,
    tenant: optional("CRM_TENANT", new URL(baseUrl).hostname.split(".")[0] ?? "default"),
    email: required("CRM_EMAIL"),
    password: required("CRM_PASSWORD"),
    totpSecret: required("CRM_TOTP_SECRET"),
  };
}

export const config = {
  packageRoot,
  baseUrl: optional("CRM_BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
  headless: optional("HEADLESS", "true") !== "false",
  stepTimeoutMs: toInt("STEP_TIMEOUT_MS", 15_000),
  maxRetries: toInt("MAX_RETRIES", 3),
  retryBaseDelayMs: toInt("RETRY_BASE_DELAY_MS", 500),
  confidenceThreshold: toFloat("CONFIDENCE_THRESHOLD", 0.8),
  stateDir: resolveFromRoot(optional("STATE_DIR", "./state")),
  artifactDir: resolveFromRoot(optional("ARTIFACT_DIR", "./artifacts")),
  logLevel: optional("LOG_LEVEL", "info"),
} as const;

/** Filesystem-safe identity for one credential set. Sessions and locks key off this. */
export function credentialKey(credentials: Pick<Credentials, "tenant" | "email">): string {
  return `${credentials.tenant}__${credentials.email}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}
