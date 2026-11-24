import { access } from "node:fs/promises";
import type { RunStartFrame } from "@kaiju/protocol/sandbox-wire";
import type { RunModel } from "../models/types.js";
import { PiProcessError } from "../pi/pi-process.js";
import { fail, type CommandOutcome } from "./outcome.js";

export const PI_REQUEST_TIMEOUT_MS = 60_000;
export const PI_SLOW_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const SLOW_COMMANDS = new Set(["compact", "abort"]);

/** The run's gateway model from `run.start.config` (both fields, else no model) and its limits. */
export function runModelOf(frame: RunStartFrame | undefined): RunModel | null {
  const model = frame?.config?.model;
  const limits = frame?.config?.model_limits;
  if (model?.gateway_model === undefined || model.api === undefined) return null;
  return {
    gatewayModel: model.gateway_model,
    api: model.api,
    ...(limits === undefined
      ? {}
      : {
          limits: {
            maxOutputTokens: limits.max_output_tokens,
            contextWindow: limits.context_window,
          },
        }),
  };
}

export function dispositionOf(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const value = (data as { disposition?: unknown }).disposition;
  return typeof value === "string" ? value : undefined;
}

export function piFailure(error: unknown): CommandOutcome {
  if (error instanceof PiProcessError) return fail("pi_unavailable", error.message);
  return fail("internal", "unexpected error talking to Pi");
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** Resolves true when `promise` did not settle within `ms` (its rejection propagates). */
export async function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<true>((resolve) => (timer = setTimeout(() => resolve(true), ms)));
  try {
    return await Promise.race([promise.then(() => false as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function raceTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
