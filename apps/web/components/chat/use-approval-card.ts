"use client";

import { useEffect, useState } from "react";
import type { ChatApi } from "../../lib/chat/api";
import type { RememberOptions } from "../../lib/chat/types";

/**
 * The exact input to approve. A resumed run keeps no inputs in its resume point: read the exact
 * input back. Until it is here, Allow stays off — the card must never approve an input it isn't
 * showing.
 */
export function useApprovalInput(
  api: Pick<ChatApi, "getApproval"> | undefined,
  approvalId: string,
  requestedInput: Record<string, unknown>,
  resolved: boolean,
) {
  const inputMissing = Object.keys(requestedInput).length === 0;
  const [input, setInput] = useState<unknown>(requestedInput);
  const [inputState, setInputState] = useState<"ready" | "loading" | "failed">(
    inputMissing ? "loading" : "ready",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!inputMissing || resolved || !api) return;
    let live = true;
    setInputState("loading");
    api
      .getApproval(approvalId)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setInput(res.data.input);
          setInputState("ready");
        } else setInputState("failed");
      })
      .catch(() => {
        if (live) setInputState("failed");
      });
    return () => {
      live = false;
    };
  }, [api, approvalId, inputMissing, resolved, attempt]);
  return { input, inputState, retry: () => setAttempt((n) => n + 1) };
}

/** What may be remembered, and whether "Approve all waiting" is offered: the server's answer. */
export function useRememberOptions(
  api: Partial<Pick<ChatApi, "rememberOptions">> | undefined,
  approvalId: string,
  askable: boolean,
  admin: unknown,
): RememberOptions | undefined {
  const [options, setOptions] = useState<RememberOptions | undefined>(undefined);
  useEffect(() => {
    const load = api?.rememberOptions;
    if (!askable || !load || admin !== undefined) return;
    let live = true;
    load(approvalId)
      .then((res) => {
        if (live && res.ok) setOptions(res.data);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, approvalId, askable, admin]);
  return options;
}
