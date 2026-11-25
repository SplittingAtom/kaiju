"use client";

import { AppWindowIcon, KeyRoundIcon, PaperclipIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";
import { listChatConnectors } from "../../lib/chat/composer-plus-api";
import { MY_CONNECTOR_KEYS } from "../../lib/apps/app-cards";
import { useAppLaunch } from "../apps/use-app-launch";
import { IconAction } from "../shell/icon-action";
import { useBoundCommands } from "../shell/command-bindings";
import { hasRailApps, useRailApps, type RailAppsState } from "../shell/rail-apps";
import { useNavigate } from "../shell/use-navigate";
import { chatPortalContainer } from "../ui/chat-portal";
import { useChatSession } from "./kaiju-runtime";
import { ConnectorsSubmenu } from "./plus-connectors";
import {
  MemorySubmenu,
  PlusFace,
  plusIndicator,
  useLearnBindings,
  useLearnNudge,
} from "./plus-learn";
import { PLUS_CONTENT, PLUS_ITEM } from "./plus-menu-styles";
import { SkillsSubmenu } from "./plus-skills";
import { useLearn, type Learn } from "./use-learn";

/** The connectors off in the thread on screen (none for a new conversation), read on open. */
function useConnectorsOff(threadId: string | null, open: boolean): ReadonlySet<string> {
  const session = useChatSession();
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!open || threadId === null) {
      setOff(new Set());
      return undefined;
    }
    let alive = true;
    void listChatConnectors(session.teamId, threadId).then((res) => {
      if (alive && res.ok) {
        setOff(new Set(res.data.connectors.filter((c) => !c.enabled).map((c) => c.connectorId)));
      }
    });
    return () => {
      alive = false;
    };
  }, [session.teamId, threadId, open]);
  return off;
}

/**
 * An item's name and, under it, a short line saying what it does (KOBE-844): the name alone is its
 * accessible name, the line its description.
 */
function useDescribed({ name, line }: { readonly name: string; readonly line: string }) {
  const id = useId();
  return {
    nameId: `${id}-name`,
    labelProps: { "aria-labelledby": `${id}-name`, "aria-describedby": `${id}-line` },
    face: (
      <span className="flex min-w-0 flex-col">
        <span id={`${id}-name`}>{name}</span>
        <span id={`${id}-line`} className="text-muted-foreground text-xs whitespace-normal">
          {line}
        </span>
      </span>
    ),
  };
}

/**
 * Browse apps (KOBE-844, Chris 2026-11-25): opens the rail's Apps view, the pickers a site admin
 * placed there, through the rail's own binding (Mod+Shift+X and the palette run the same).
 * Only when the member has apps, as the rail's view.
 */
function BrowseAppsItem({
  apps,
  keepFocus,
}: {
  readonly apps: RailAppsState | null;
  /** The rail's Apps view takes the focus: the menu leaves it there when it closes. */
  keepFocus(): void;
}) {
  const bound = useBoundCommands();
  const { labelProps, face } = useDescribed({
    name: "Browse apps",
    line: "Open your app pickers in the side rail",
  });
  const browse = bound["browse-apps"];
  if (!hasRailApps(apps) || browse === undefined) return null;
  return (
    <DropdownMenu.Item
      className={PLUS_ITEM}
      data-command="browse-apps"
      {...labelProps}
      onSelect={() => {
        keepFocus();
        browse.onSelect?.();
      }}
    >
      <AppWindowIcon aria-hidden className="size-4 shrink-0" />
      {face}
    </DropdownMenu.Item>
  );
}

/** The + menu's Apps (KOBE-451): an app card in the conversation, launched as the rail did. */
function AppsSubmenu({
  apps,
  threadId,
  open,
}: {
  readonly apps: RailAppsState | null;
  readonly threadId: string | null;
  readonly open: boolean;
}) {
  const { nameId, labelProps, face } = useDescribed({
    name: "Apps",
    line: "Add an app card to this conversation",
  });
  // An app whose connector is off in this conversation is not offered here (review LOW-5); the
  // server refuses its card there too.
  const off = useConnectorsOff(threadId, open);
  const shown = (apps?.apps ?? []).filter((app) => !off.has(app.connectorId));
  const navigate = useNavigate();
  const { busy, error, launch } = useAppLaunch();
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={PLUS_ITEM} data-kaiju-plus="apps" {...labelProps}>
        <AppWindowIcon aria-hidden className="size-4 shrink-0" />
        {face}
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.SubContent
          data-kaiju-portal
          aria-labelledby={nameId}
          sideOffset={4}
          className={PLUS_CONTENT}
        >
          {(!hasRailApps(apps) || (shown.length === 0 && apps.needsKey.length === 0)) && (
            <p className="text-muted-foreground m-0 px-2 py-1.5 text-sm">No apps for you here.</p>
          )}
          {shown.map((app) => (
            <DropdownMenu.Item
              key={app.appId}
              className={PLUS_ITEM}
              data-kaiju-app={app.appId}
              aria-busy={busy === app.appId || undefined}
              onSelect={() => void launch(app)}
            >
              <AppWindowIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{app.title}</span>
              <span className="text-muted-foreground ms-auto truncate text-xs">
                {app.connectorName}
              </span>
            </DropdownMenu.Item>
          ))}
          {apps?.needsKey.map((hint) => (
            <DropdownMenu.Item
              key={`${hint.connectorId}:${hint.title}`}
              className={PLUS_ITEM}
              onSelect={() => navigate(MY_CONNECTOR_KEYS)}
            >
              <KeyRoundIcon aria-hidden className="size-4 shrink-0" />
              <span className="whitespace-normal">
                Add your key to use {hint.title} from {hint.connectorName}
              </span>
            </DropdownMenu.Item>
          ))}
          {error !== null && (
            <p role="alert" className="text-destructive m-0 max-w-64 px-2 py-1.5 text-xs">
              {error}
            </p>
          )}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/** Apps and Browse apps, from one read of the member's apps, made while the menu is open. */
function AppsItems({
  threadId,
  open,
  keepFocus,
}: {
  readonly threadId: string | null;
  readonly open: boolean;
  keepFocus(): void;
}) {
  const apps = useRailApps();
  return (
    <>
      <AppsSubmenu apps={apps} threadId={threadId} open={open} />
      <BrowseAppsItem apps={apps} keepFocus={keepFocus} />
    </>
  );
}

/** A Learn notice beside the + button: started, refused with the reason, or finished. */
function LearnNotice({ learn }: { readonly learn: Learn }) {
  const { text, n } = learn.notice;
  return (
    <span
      role="status"
      data-kaiju-learn-notice=""
      className={
        text === ""
          ? "sr-only"
          : "bg-background text-foreground absolute bottom-full start-0 z-30 mb-2 w-max max-w-[min(20rem,calc(100vw-2rem))] rounded-md border px-2 py-1 text-xs whitespace-normal shadow-md"
      }
    >
      {text}
      {n % 2 === 1 && text !== "" ? "\u00a0" : ""}
    </span>
  );
}

/**
 * The composer's + menu (KOBE-451): everything that adds to a message under one button, opening
 * upward. Attach files (drag and drop onto the composer still attaches), Connectors (on or off
 * for this conversation), Memory (Learn from this chat, KOBE-395), Skills (a chip the server
 * checks), Apps (an app card) and Browse apps (the rail's Apps view, KOBE-844). Radix's menu button: Enter, Space or the
 * arrows open it, arrows move and open submenus, Escape closes and returns the focus. The button
 * carries the Learn state (KOBE-395): a spinner while a pass runs, the count of candidates from
 * this chat waiting in To review, or a dot for new messages since the last pass, which pulses
 * once when the server nudges (KOBE-410: enough new messages or a correction). The composer
 * renders it only for the thread's owner (a shared reader gets the banner instead).
 */
export function PlusMenu({
  draft,
  threadId,
  threadRunning = false,
  onAttach,
}: {
  readonly draft: string;
  /** The thread on screen; null for a conversation not started yet. */
  readonly threadId: string | null;
  /** A run holds the thread: the Learn state is read again when it ends. */
  readonly threadRunning?: boolean;
  readonly onAttach: () => void;
}) {
  const [open, setOpen] = useState(false);
  const learn = useLearn(threadId, threadRunning);
  useLearnBindings(learn, threadId);
  const face = plusIndicator(learn.state);
  const pulse = useLearnNudge(threadId, learn.state);
  // Browse apps moves the focus to the rail's Apps view; the menu must not take it back.
  const focusMoved = useRef(false);
  return (
    <span className="relative inline-flex shrink-0" data-kaiju-plus-wrap="">
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconAction
            command="plus-menu"
            className="size-7 shrink-0 rounded-full"
            side="top"
            description={face.description}
            data-kaiju-learn-state={face.mark ?? undefined}
          >
            <PlusFace face={face} pulse={pulse} />
          </IconAction>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={chatPortalContainer()}>
          <DropdownMenu.Content
            data-kaiju-portal
            data-kaiju-plus-menu
            side="top"
            align="start"
            sideOffset={6}
            className={PLUS_CONTENT}
            onCloseAutoFocus={(e) => {
              if (!focusMoved.current) return;
              focusMoved.current = false;
              e.preventDefault();
            }}
          >
            <DropdownMenu.Item className={PLUS_ITEM} data-command="attach" onSelect={onAttach}>
              <PaperclipIcon aria-hidden className="size-4 shrink-0" />
              Attach files
            </DropdownMenu.Item>
            <ConnectorsSubmenu threadId={threadId} open={open} />
            <MemorySubmenu learn={learn} threadId={threadId} />
            <SkillsSubmenu draft={draft} threadId={threadId} open={open} />
            <AppsItems
              threadId={threadId}
              open={open}
              keepFocus={() => {
                focusMoved.current = true;
              }}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <LearnNotice learn={learn} />
    </span>
  );
}
