"use client";

import { AppWindowIcon, KeyRoundIcon, PaperclipIcon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import { listChatConnectors } from "../../lib/chat/composer-plus-api";
import { MY_CONNECTOR_KEYS } from "../../lib/apps/app-cards";
import { useAppLaunch } from "../apps/use-app-launch";
import { IconAction } from "../shell/icon-action";
import { hasRailApps, useRailApps } from "../shell/rail-apps";
import { useNavigate } from "../shell/use-navigate";
import { chatPortalContainer } from "../ui/chat-portal";
import { useChatSession } from "./kobe-runtime";
import { ConnectorsSubmenu } from "./plus-connectors";
import { MemorySubmenu, PlusFace, plusIndicator, useLearnBindings } from "./plus-learn";
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

/** The + menu's Apps (KOBE-451): the rail's Apps, launched exactly as the rail launches them. */
function AppsSubmenu({
  threadId,
  open,
}: {
  readonly threadId: string | null;
  readonly open: boolean;
}) {
  const apps = useRailApps();
  // An app whose connector is off in this conversation is not offered here (review LOW-5); the
  // server refuses its card there too.
  const off = useConnectorsOff(threadId, open);
  const shown = (apps?.apps ?? []).filter((app) => !off.has(app.connectorId));
  const navigate = useNavigate();
  const { busy, error, launch } = useAppLaunch();
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={PLUS_ITEM} data-kobe-plus="apps">
        <AppWindowIcon aria-hidden className="size-4 shrink-0" />
        Apps
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal container={chatPortalContainer()}>
        <DropdownMenu.SubContent
          data-kobe-portal
          aria-label="Apps"
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
              data-kobe-app={app.appId}
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

/** A Learn notice beside the + button: started, refused with the reason, or finished. */
function LearnNotice({ learn }: { readonly learn: Learn }) {
  const { text, n } = learn.notice;
  return (
    <span
      role="status"
      data-kobe-learn-notice=""
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
 * checks) and Apps (an app card, as from the rail). Radix's menu button: Enter, Space or the
 * arrows open it, arrows move and open submenus, Escape closes and returns the focus. The button
 * carries the Learn state (KOBE-395): a spinner while a pass runs, the count of candidates from
 * this chat waiting in To review, or a dot for new messages since the last pass. The composer
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
  return (
    <span className="relative inline-flex shrink-0" data-kobe-plus-wrap="">
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconAction
            command="plus-menu"
            className="size-7 shrink-0 rounded-full"
            side="top"
            description={face.description}
            data-kobe-learn-state={face.mark ?? undefined}
          >
            <PlusFace face={face} />
          </IconAction>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal container={chatPortalContainer()}>
          <DropdownMenu.Content
            data-kobe-portal
            data-kobe-plus-menu
            side="top"
            align="start"
            sideOffset={6}
            className={PLUS_CONTENT}
          >
            <DropdownMenu.Item className={PLUS_ITEM} data-command="attach" onSelect={onAttach}>
              <PaperclipIcon aria-hidden className="size-4 shrink-0" />
              Attach files
            </DropdownMenu.Item>
            <ConnectorsSubmenu threadId={threadId} open={open} />
            <MemorySubmenu learn={learn} threadId={threadId} />
            <SkillsSubmenu draft={draft} threadId={threadId} open={open} />
            <AppsSubmenu threadId={threadId} open={open} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <LearnNotice learn={learn} />
    </span>
  );
}
