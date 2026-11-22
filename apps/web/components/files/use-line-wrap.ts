"use client";

import { useState } from "react";
import { useShellPreferences } from "../../lib/shell/preferences";

/**
 * The code editor's line-wrap toggle (KOBE-806): on by default, remembered per member through the
 * shell's layout preferences (`editor_line_wrap`). Outside the shell (tests, a page on its own)
 * it only lasts for the page. A choice made on this page wins over a preference that loads later.
 */
export function useLineWrap(): readonly [boolean, (next: boolean) => void] {
  const shell = useShellPreferences();
  const [chosen, setChosen] = useState<boolean | undefined>(undefined);
  const wrap = chosen ?? shell?.preferences?.editorLineWrap ?? true;
  const save = shell?.save;
  const set = (next: boolean) => {
    setChosen(next);
    save?.({ editorLineWrap: next });
  };
  return [wrap, set] as const;
}
