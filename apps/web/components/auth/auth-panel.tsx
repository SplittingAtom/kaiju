"use client";

import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { FOCUS_RING } from "../ui/console";
import { Brand } from "../shell/brand";
import { useBranding } from "../shell/branding-context";

/** A plain link inside the panel (footer links, "Forgot your password?"), themed and focusable. */
export const AUTH_LINK = cn(
  "rounded-sm text-sm text-console-accent underline-offset-4 hover:underline",
  FOCUS_RING,
);

/**
 * The panel's look, in utilities only: the signed-out pages get the app's Tailwind build but sit
 * under neither the chat nor the console root, whose `kaiju-panel` rule they would miss. So the
 * hover glow (KOBE-550's tokens) is spelled out here, same colours, hover devices only, no easing
 * for reduced motion.
 */
const PANEL = [
  "box-border flex w-full max-w-[400px] flex-col gap-5 rounded-xl border border-console-border bg-console-bg p-6 shadow-sm sm:p-8",
  "transition-[border-color,box-shadow] duration-300 motion-reduce:transition-none",
  "[@media(hover:hover)]:hover:border-[var(--kaiju-panel-border-hover)] [@media(hover:hover)]:hover:shadow-[var(--kaiju-glow-panel)]",
].join(" ");

/**
 * The signed-out pages' layout (KOBE-755): sign-in, forgot and reset password, invitation, setup
 * and the SSO-link confirmation. One panel, centred horizontally and vertically on the themed page
 * background, at most 400 px wide with a 16 px gutter on a phone. It carries the Site's theme like
 * the rest of the app: the root layout renders the Site preset's tokens and the visitor's light or
 * dark preference into the first HTML, so nothing paints unthemed; the logo (or the themed logo)
 * comes from the Site branding, and the name only through `title`, never hard-coded. The panel is
 * the page's region, named by its title. A full-screen layer of its own, so the page needs no
 * global body rule.
 */
export function AuthPanel({
  title,
  children,
  footer,
}: {
  /** The page's h1; omitted while a page is still loading. */
  readonly title?: ReactNode;
  readonly children: ReactNode;
  /** A link under the panel's body, for example back to sign-in. */
  readonly footer?: ReactNode;
}) {
  const { logo } = useBranding();
  const titleId = useId();
  return (
    <div
      data-auth-page=""
      className="fixed inset-0 overflow-y-auto bg-console-panel font-sans text-console-fg"
    >
      <main className="box-border flex min-h-full items-center justify-center px-4 py-8">
        <section
          data-auth-panel=""
          aria-labelledby={title === undefined ? undefined : titleId}
          className={PANEL}
        >
          {(logo !== null || title !== undefined) && (
            <header className="flex flex-col items-center gap-3 text-center">
              {logo !== null && (
                <span data-auth-logo="" className="flex items-center text-lg font-semibold">
                  <Brand />
                </span>
              )}
              {title !== undefined && (
                <h1 id={titleId} className="m-0 text-xl leading-7 font-semibold">
                  {title}
                </h1>
              )}
            </header>
          )}
          <div className="flex flex-col gap-4">{children}</div>
          {footer !== undefined && (
            <footer className="border-t border-console-border pt-4 text-center text-sm">
              {footer}
            </footer>
          )}
        </section>
      </main>
    </div>
  );
}

/** The divider before the other ways to sign in ("or"), a decoration: the group has its name. */
export function AuthDivider({ children = "or" }: { readonly children?: ReactNode }) {
  return (
    <div
      data-auth-divider=""
      aria-hidden="true"
      className="flex items-center gap-3 text-xs tracking-wide text-console-muted uppercase"
    >
      <span className="h-px flex-1 bg-console-border" />
      {children}
      <span className="h-px flex-1 bg-console-border" />
    </div>
  );
}
