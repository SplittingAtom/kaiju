import { z } from "zod";

export type SmtpSecurity = "starttls" | "tls" | "none";

export interface MailAddress {
  readonly name?: string;
  readonly address: string;
}

/** SMTP settings (spec D7: SMTP is required; invites, resets and notifications go through it). */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  /** starttls: upgrade required (port 587); tls: implicit TLS (465); none: plain (dev relays). */
  readonly security: SmtpSecurity;
  readonly from: MailAddress;
  readonly auth?: { readonly user: string; readonly pass: string };
}

const emailSchema = z.email();
// "Name <address>" or a bare address; no CR/LF, quotes, angle brackets or commas in the name.
const FROM_PATTERN = /^(?:([^<>",\r\n]{1,100}?)\s*<([^<>\s,]+)>|([^<>\s,"]+))$/;

/** Parses KAIJU_SMTP_FROM; undefined when malformed. */
export function parseFrom(value: string): MailAddress | undefined {
  const match = FROM_PATTERN.exec(value.trim());
  if (!match) return undefined;
  const name = match[1]?.trim();
  const address = (match[2] ?? match[3] ?? "").toLowerCase();
  if (!emailSchema.safeParse(address).success) return undefined;
  return name ? { name, address } : { address };
}

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v));

export const smtpSchema = z
  .object({
    KAIJU_SMTP_HOST: z
      .string({ error: "KAIJU_SMTP_HOST is required" })
      .trim()
      .min(1, "KAIJU_SMTP_HOST is required")
      .max(253)
      .regex(/^[A-Za-z0-9.:[\]-]+$/, "KAIJU_SMTP_HOST must be a host name or IP address"),
    KAIJU_SMTP_PORT: z.coerce
      .number({ error: "KAIJU_SMTP_PORT must be a number" })
      .int("KAIJU_SMTP_PORT must be an integer")
      .min(1, "KAIJU_SMTP_PORT must be between 1 and 65535")
      .max(65535, "KAIJU_SMTP_PORT must be between 1 and 65535")
      .default(587),
    KAIJU_SMTP_SECURITY: z
      .enum(["starttls", "tls", "none"], {
        error: "KAIJU_SMTP_SECURITY must be starttls, tls or none",
      })
      .default("starttls"),
    KAIJU_SMTP_FROM: z.string({ error: "KAIJU_SMTP_FROM is required" }).transform((v, ctx) => {
      const from = parseFrom(v);
      if (!from) {
        ctx.addIssue({
          code: "custom",
          message: 'KAIJU_SMTP_FROM must be "Name <address>" or an address',
        });
        return z.NEVER;
      }
      return from;
    }),
    KAIJU_SMTP_USERNAME: optionalSecret,
    KAIJU_SMTP_PASSWORD: optionalSecret,
  })
  .superRefine((v, ctx) => {
    if ((v.KAIJU_SMTP_USERNAME === undefined) !== (v.KAIJU_SMTP_PASSWORD === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["KAIJU_SMTP_PASSWORD"],
        message: "KAIJU_SMTP_USERNAME and KAIJU_SMTP_PASSWORD must be set together",
      });
    }
    if (v.KAIJU_SMTP_SECURITY === "none" && v.KAIJU_SMTP_PASSWORD !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["KAIJU_SMTP_SECURITY"],
        message: "KAIJU_SMTP_SECURITY=none would send SMTP credentials unencrypted",
      });
    }
  })
  .transform((v): SmtpConfig => ({
    host: v.KAIJU_SMTP_HOST,
    port: v.KAIJU_SMTP_PORT,
    security: v.KAIJU_SMTP_SECURITY,
    from: v.KAIJU_SMTP_FROM,
    ...(v.KAIJU_SMTP_USERNAME !== undefined && v.KAIJU_SMTP_PASSWORD !== undefined
      ? { auth: { user: v.KAIJU_SMTP_USERNAME, pass: v.KAIJU_SMTP_PASSWORD } }
      : {}),
  }));
