"use client";

import { useEffect, useState } from "react";
import {
  clearOauthReturn,
  oauthReturnText,
  readOauthReturn,
  type OauthReturn,
} from "../../lib/connectors/oauth-return";
import { Notice } from "../ui/console";

/**
 * The OAuth connect result the callback put in the address (KOBE-835), read once when the page
 * opens; the parameters are then taken out of the address so a reload does not show it again.
 */
export function useOauthReturn(): OauthReturn | null {
  const [result] = useState(() =>
    typeof window === "undefined" ? null : readOauthReturn(window.location.search),
  );
  useEffect(() => {
    if (result !== null) clearOauthReturn();
  }, [result]);
  return result;
}

/** The result as a notice: success, or an error with Kobe's own sentence for the reason. */
export function OauthReturnNotice({
  result,
  name,
}: {
  readonly result: OauthReturn;
  /** The connector's name from the page's own list (never from the address). */
  readonly name: string | undefined;
}) {
  return (
    <Notice tone={result.ok ? "success" : "error"} role={result.ok ? "status" : "alert"}>
      <p>{oauthReturnText(result, name)}</p>
    </Notice>
  );
}
