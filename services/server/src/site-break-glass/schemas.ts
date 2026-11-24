import { z } from "zod";
import {
  BREAK_GLASS_DEFAULT_MINUTES,
  BREAK_GLASS_MAX_MINUTES,
  BREAK_GLASS_REASON_MAX,
  PORTABLE_BREAK_GLASS_ITEMS_MAX,
} from "@kaiju/db";

const id = z.uuid().transform((v) => v.toLowerCase());

/** `POST /v1/site/portable-break-glass` (KOBE-648): one person's portable memories. */
export const requestSiteGrantSchema = z.strictObject({
  subjectUserId: id,
  reason: z
    .string()
    .trim()
    .min(10, "Explain why in at least 10 characters.")
    .max(BREAK_GLASS_REASON_MAX),
  durationMinutes: z
    .number()
    .int()
    .min(5)
    .max(BREAK_GLASS_MAX_MINUTES)
    .default(BREAK_GLASS_DEFAULT_MINUTES),
  legalHold: z.boolean().default(false),
});

export type RequestSiteGrantBody = z.infer<typeof requestSiteGrantSchema>;

export const listSiteGrantsQuerySchema = z.strictObject({
  status: z.enum(["pending", "active", "denied", "revoked", "expired"]).optional(),
});

export const siteGrantItemsQuerySchema = z.strictObject({
  after: id.optional(),
  limit: z.coerce.number().int().min(1).max(PORTABLE_BREAK_GLASS_ITEMS_MAX).default(50),
});

export const siteIdParamSchema = id;
