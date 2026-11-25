"use client";

import {
  FlaskConicalIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LogOutIcon,
  PlugIcon,
  ShieldCheckIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type MouseEvent } from "react";
import { authClient } from "../../lib/auth-client";
import { forgetReloadDrafts } from "../../lib/build/reload-draft";
import { forgetLastThread } from "../../lib/shell/last-thread";
import { barMenuProps } from "./bar-menu";
import { IconAction } from "./icon-action";
import { command } from "../../lib/shell/commands";
import { MENU_ICON, MenuLink } from "./text-links";
import styles from "./shell.module.css";

interface ProfileLink {
  readonly name: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

/** A registry command shown in this menu: its name, page and the icon it had in the bar. */
function fromRegistry(id: "my-memory" | "my-schedules"): ProfileLink {
  const c = command(id);
  if (c.href === undefined) throw new Error(`Command ${id} has no page`);
  return { name: c.name, href: c.href, icon: c.icon };
}

/**
 * The menu's links in order, each with its icon (KOBE-843). My memory and My schedules moved here
 * from the bar and keep the registry's icons (also the palette's and `/` menu's entries).
 */
export const PROFILE_LINKS: readonly ProfileLink[] = [
  { name: "Projects", href: "/me/projects", icon: FolderKanbanIcon },
  fromRegistry("my-memory"),
  fromRegistry("my-schedules"),
  { name: "My connectors", href: "/me/connectors", icon: PlugIcon },
  { name: "My approvals", href: "/me/approvals", icon: ShieldCheckIcon },
  { name: "My shared cases", href: "/me/shared-cases", icon: FlaskConicalIcon },
  { name: "Sign-in methods", href: "/me/sign-in-methods", icon: KeyRoundIcon },
];

/**
 * The profile menu at the bar's right end (CE3): the member's other areas (My memory and My
 * schedules among them since KOBE-843) and sign-out, every item after its icon. A
 * disclosure, like the team switcher; one of the two is open at a time. Each page opens as a panel
 * over the workspace (KOBE-452; Skills is a bar command, KOBE-321), and the menu closes behind it.
 * Slot: a member settings page joins this menu when one exists.
 */
export function ProfileMenu() {
  const [error, setError] = useState<string | null>(null);
  /** The page opens in a panel (KOBE-452): the menu doesn't stay open behind it. */
  const close = (e: MouseEvent<HTMLAnchorElement>) => {
    const menu = e.currentTarget.closest("details");
    if (menu) menu.open = false;
  };

  async function signOut() {
    setError(null);
    try {
      const res = await authClient.signOut();
      if (res.error) {
        setError(res.error.message ?? "Could not sign out. Try again.");
        return;
      }
      forgetLastThread();
      forgetReloadDrafts();
      window.location.assign("/sign-in");
    } catch {
      setError("Could not sign out. Check your connection and try again.");
    }
  }

  return (
    <details className={styles.menu} {...barMenuProps}>
      <IconAction command="profile" as="summary" className={styles.iconLink} />
      <ul className={styles.menuList}>
        {PROFILE_LINKS.map((item) => (
          <li key={item.href}>
            <MenuLink href={item.href} icon={item.icon} onClick={close}>
              {item.name}
            </MenuLink>
          </li>
        ))}
        <li>
          <button type="button" onClick={() => void signOut()}>
            <LogOutIcon aria-hidden data-menu-icon="" className={MENU_ICON} />
            <span>Sign out</span>
          </button>
        </li>
        {error && (
          <li role="alert" className={styles.menuError}>
            {error}
          </li>
        )}
      </ul>
    </details>
  );
}
