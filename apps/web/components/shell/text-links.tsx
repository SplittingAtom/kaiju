"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

/**
 * The two places the chat shell keeps a text link (CE13, KOBE-203); the lint rule against bare
 * text links (`eslint.config.js`) lets these through and nothing else. Navigation and actions are
 * `IconAction`s; don't reach for these to label a control.
 */

interface TextLinkProps {
  readonly href: string;
  /** A file download: a plain link the router leaves alone. */
  readonly download?: boolean | undefined;
  /** In-app navigation without a page load (call `preventDefault`), e.g. opening a thread. */
  readonly onClick?: ((e: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  readonly children: ReactNode;
}

function TextLink({ href, download, onClick, children }: TextLinkProps) {
  return download ? (
    <a href={href} download onClick={onClick}>
      {children}
    </a>
  ) : (
    <Link href={href} {...(onClick ? { onClick } : {})}>
      {children}
    </Link>
  );
}

/** Prose only: a link inside a sentence ("Export your conversations to keep a copy"). */
export function InlineLink(props: TextLinkProps) {
  return <TextLink {...props} />;
}

/**
 * An item of a bar disclosure menu (the profile menu): a menu lists names, which are text, each
 * after its icon (KOBE-843), which is decoration (`aria-hidden`); the name stays the label.
 */
export function MenuLink({ icon: Icon, children, ...props }: TextLinkProps & MenuIconProps) {
  return (
    <TextLink {...props}>
      <Icon aria-hidden data-menu-icon="" className={MENU_ICON} />
      <span>{children}</span>
    </TextLink>
  );
}

/** Every profile menu item's icon: one size, aligned with its name (KOBE-843). */
export const MENU_ICON = "size-4 shrink-0";

export interface MenuIconProps {
  readonly icon: LucideIcon;
}
