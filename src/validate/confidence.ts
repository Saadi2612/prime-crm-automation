import { config } from "../config/index.js";
import { ValidationError } from "../jobs/errors.js";
import {
  leadPayloadSchema,
  type ConfidenceMap,
  type LeadPayload,
} from "./schema.js";

/**
 * Validation and confidence gating.
 *
 * Two independent questions, deliberately kept apart:
 *
 *   1. Is this payload *well-formed*? A malformed payload is a hard failure —
 *      no human review will fix an email that is not an email.
 *   2. Is this payload *trustworthy*? A well-formed payload whose fields carry
 *      low confidence is not wrong, it is uncertain. Uncertainty is a question
 *      for a person, not grounds for rejection, so it routes to review.
 */

export interface FieldConfidence {
  field: string;
  score: number;
  belowThreshold: boolean;
}

export interface ValidationOutcome {
  payload: LeadPayload;
  fields: FieldConfidence[];
  minConfidence: number;
  lowConfidenceFields: string[];
  needsReview: boolean;
  threshold: number;
}

/** Fields absent from the confidence map are treated as certain. */
const DEFAULT_SCORE = 1;

export function validateLead(
  rawPayload: Record<string, unknown>,
  confidence: ConfidenceMap = {},
  threshold = config.confidenceThreshold,
): ValidationOutcome {
  const parsed = leadPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) {
    // Field names and codes only — the rejected values are never logged.
    const issues = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      code: issue.code,
      message: issue.message,
    }));
    throw new ValidationError(
      `Payload failed schema validation: ${issues.map((i) => `${i.field} (${i.message})`).join("; ")}`,
      { issues },
    );
  }

  const payload = parsed.data;

  const fields: FieldConfidence[] = Object.keys(payload)
    .filter((key) => payload[key as keyof LeadPayload] != null)
    .map((field) => {
      const score = confidence[field] ?? DEFAULT_SCORE;
      return { field, score, belowThreshold: score < threshold };
    });

  const lowConfidenceFields = fields.filter((f) => f.belowThreshold).map((f) => f.field);
  const minConfidence = fields.length ? Math.min(...fields.map((f) => f.score)) : DEFAULT_SCORE;

  return {
    payload,
    fields,
    minConfidence,
    lowConfidenceFields,
    needsReview: lowConfidenceFields.length > 0,
    threshold,
  };
}

/** Confidence map keyed by field, for storing alongside the job. */
export function toConfidenceMap(fields: FieldConfidence[]): Record<string, number> {
  return Object.fromEntries(fields.map((f) => [f.field, f.score]));
}
