"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import type { Size } from "../../lib/files/viewer";

/**
 * An element's inner size, following the column as it is resized (ResizeObserver where the browser
 * has it); the file viewers fit their content to it (KOBE-801, KOBE-807).
 */
export function useBoxSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
