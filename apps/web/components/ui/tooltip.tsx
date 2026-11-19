"use client";

import * as React from "react";
import { chatPortalContainer } from "./chat-portal";
import { cn } from "../../lib/utils";
import { Tooltip as TooltipPrimitive } from "radix-ui";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/**
 * Tabbing to a trigger that is scrolled out of view makes the browser scroll it in, and Radix
 * closes a tooltip on any scroll of a trigger's ancestor, so the tooltip opened by that focus
 * closed again at once (KOBE-654; hover is unaffected: the pointer arrives after the scroll). The
 * guard ignores a close that a scroll caused while the trigger still has focus.
 */
interface FocusGuard {
  readonly onFocus: (event: React.FocusEvent<HTMLElement>) => void;
}
const FocusGuardContext = React.createContext<FocusGuard | null>(null);

/** How long after a focus a scroll still counts as the one that focus caused (ms). */
export const FOCUS_SCROLL_WINDOW_MS = 300;

function Tooltip({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [inner, setInner] = React.useState(defaultOpen);
  const open = controlledOpen ?? inner;
  const trigger = React.useRef<HTMLElement | null>(null);
  const scrolled = React.useRef(false);
  const stop = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => stop.current?.(), []);
  const guard = React.useMemo<FocusGuard>(
    () => ({
      onFocus: (event) => {
        stop.current?.();
        trigger.current = event.currentTarget;
        scrolled.current = false;
        // Registered before Radix's own listener (it mounts with the content), so it runs first.
        const onScroll = () => {
          scrolled.current = true;
        };
        window.addEventListener("scroll", onScroll, true);
        // Escape and a press outside always dismiss (WCAG 1.4.13): end the guard before Radix closes.
        const onDismiss = (e: Event) => {
          if (e.type === "pointerdown" || (e as KeyboardEvent).key === "Escape") stop.current?.();
        };
        document.addEventListener("keydown", onDismiss, true);
        document.addEventListener("pointerdown", onDismiss, true);
        const timer = window.setTimeout(() => stop.current?.(), FOCUS_SCROLL_WINDOW_MS);
        stop.current = () => {
          window.removeEventListener("scroll", onScroll, true);
          document.removeEventListener("keydown", onDismiss, true);
          document.removeEventListener("pointerdown", onDismiss, true);
          window.clearTimeout(timer);
          scrolled.current = false;
          stop.current = null;
        };
      },
    }),
    [],
  );
  const change = (next: boolean) => {
    if (!next && scrolled.current && document.activeElement === trigger.current) return;
    if (controlledOpen === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <FocusGuardContext.Provider value={guard}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={change} {...props} />
    </FocusGuardContext.Provider>
  );
}

function TooltipTrigger({
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const guard = React.useContext(FocusGuardContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onFocus={(event) => {
        onFocus?.(event);
        guard?.onFocus(event);
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal container={chatPortalContainer()}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
