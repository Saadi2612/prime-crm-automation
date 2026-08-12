import { z } from "zod";

/**
 * Input contract for a lead. Validated before the browser opens — starting a
 * session and typing half a form only to discover the payload was never usable
 * wastes a login and leaves the UI in a dirty state.
 */
export const leadPayloadSchema = z.object({
  full_name: z.string().trim().min(1, "full_name is required").max(255),
  email: z.string().trim().email("email must be a valid address").max(255).optional(),
  phone: z.string().trim().min(5).max(64).optional(),
  job_title: z.string().trim().max(255).optional(),
  min_budget: z.number().nonnegative().optional(),
  max_budget: z.number().nonnegative().optional(),
  notes: z.string().trim().max(2000).optional(),
}).refine(
  (value) =>
    value.min_budget == null || value.max_budget == null || value.min_budget <= value.max_budget,
  { message: "min_budget must be less than or equal to max_budget", path: ["max_budget"] },
);

export type LeadPayload = z.infer<typeof leadPayloadSchema>;

/**
 * Per-field confidence, 0..1. In a real pipeline these come from whatever
 * produced the data — an OCR engine, an LLM extraction, a fuzzy CRM match.
 * Here they are supplied with the input, because the harness's job is to act
 * on them correctly, not to invent them.
 */
export const confidenceSchema = z.record(z.string(), z.number().min(0).max(1));

export type ConfidenceMap = z.infer<typeof confidenceSchema>;

export const jobInputSchema = z.object({
  payload: z.record(z.string(), z.unknown()),
  confidence: confidenceSchema.optional(),
});

export type JobInput = z.infer<typeof jobInputSchema>;
