// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_FOCUS_ATTR,
  autoFocusComposer,
  PENDING_REQUEST_MS,
  focusRequest,
  focusVerdict,
  isTypingField,
} from "../../lib/chat/composer-focus";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { openApp, threadGroup } from "./testing";
import { resetComposerFocusForTests, useComposerAutoFocus } from "./use-composer-focus";

/**
 * KOBE-840 ac-4: the composer takes the focus on page load, on New chat and when a thread is
 * chosen in the Threads panel; never over an open dialog or menu, never from another field, and
 * not at page load on a touch screen.
 */
let fake: FakeKaiju;
const WAIT = { timeout: 5_000 };

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetComposerFocusForTests();
  fake = new FakeKaiju();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const message = () => screen.findByLabelText("Message", undefined, WAIT);
const focused = async () =>
  waitFor(async () => expect(document.activeElement).toBe(await message()), WAIT);
/** A few frames: long enough for the composer's two-frame request to have run. */
const frames = () => new Promise((resolve) => setTimeout(resolve, 120));

function coarse(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(pointer: coarse)" ? matches : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })),
  );
}

describe("composer focus (KOBE-840)", { timeout: 20_000 }, () => {
  it("is in the composer after the page loads", async () => {
    openApp(fake);
    await focused();
  });

  it("is in the composer after the page loads on a thread", async () => {
    openApp(fake, fake.addThread("Budget"));
    await focused();
  });

  it("does not pop the keyboard at page load on a touch screen", async () => {
    coarse(true);
    openApp(fake);
    await message();
    await frames();
    expect(document.activeElement).not.toBe(await message());
  });

  it("comes back to the composer on New chat", async () => {
    openApp(fake, fake.addThread("Budget"));
    await focused();
    const user = userEvent.setup();
    const newChat = (await screen.findAllByRole("button", { name: "New conversation" }))[0];
    if (newChat === undefined) throw new Error("no New conversation button");
    await user.click(newChat);
    await waitFor(() => expect(window.location.search).not.toContain("thread="), WAIT);
    await focused();
  });

  it("comes to the composer when a thread is chosen in the Threads panel", async () => {
    fake.addThread("Budget review");
    openApp(fake);
    await focused();
    const user = userEvent.setup();
    const row = await within(await threadGroup("Your threads")).findByRole(
      "button",
      { name: "Budget review" },
      WAIT,
    );
    await user.click(row);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull(), WAIT);
    await waitFor(
      () =>
        expect(document.getElementById("kaiju-thread-title")?.textContent).toBe("Budget review"),
      WAIT,
    );
    await focused();
  });

  it("leaves the focus in another field the member is typing in", async () => {
    const other = document.createElement("input");
    other.setAttribute("aria-label", "Elsewhere");
    document.body.append(other);
    other.focus();
    openApp(fake);
    await message();
    await frames();
    expect(document.activeElement).toBe(other);
  });
});

describe("the focus rules (KOBE-840)", () => {
  function setUp() {
    const composer = document.createElement("textarea");
    const button = document.createElement("button");
    document.body.append(composer, button);
    return { composer, button };
  }

  it("focuses from the page or the button that asked; skips once the member moved on", () => {
    const { composer, button } = setUp();
    expect(focusVerdict(document, composer)).toBe("focus");
    button.focus();
    const request = focusRequest(document);
    expect(focusVerdict(document, composer, request)).toBe("focus");
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();
    expect(focusVerdict(document, composer, request)).toBe("skip");
  });

  it("a missing composer keeps the request pending; a layer opened since ends it", () => {
    const request = focusRequest(document);
    expect(focusVerdict(document, null, request)).toBe("missing");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(focusVerdict(document, null, request)).toBe("skip");
  });

  it("waits while a dialog or menu is open, then focuses once the chosen-in layer closed", () => {
    const { composer, button } = setUp();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const row = document.createElement("button");
    dialog.append(row);
    document.body.append(dialog);
    row.focus();
    const request = focusRequest(document);
    expect(request.fromLayer).toBe(true);
    expect(focusVerdict(document, composer, request)).toBe("wait");
    // The panel closes and puts the focus back on the button that opened it.
    dialog.remove();
    button.focus();
    expect(focusVerdict(document, composer, request)).toBe("focus");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    expect(focusVerdict(document, composer, request)).toBe("wait");
  });

  it("never takes the focus from another field, and does nothing when already there", () => {
    const { composer } = setUp();
    const input = document.createElement("input");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    document.body.append(input, checkbox);
    input.focus();
    expect(focusVerdict(document, composer)).toBe("skip");
    expect(isTypingField(input, composer)).toBe(true);
    expect(isTypingField(checkbox, composer)).toBe(false);
    expect(isTypingField(composer, composer)).toBe(false);
    composer.focus();
    expect(focusVerdict(document, composer)).toBe("skip");
    expect(focusVerdict(document, null)).toBe("skip"); // another field has the focus
  });

  it("at page load only the page itself may hand over the focus", () => {
    const { composer, button } = setUp();
    button.focus();
    expect(focusVerdict(document, composer, focusRequest(document, true))).toBe("skip");
    button.blur();
    expect(focusVerdict(document, composer, focusRequest(document, true))).toBe("focus");
  });

  it("marks a focus it took until the member types, so an opening editor may take it", () => {
    const { composer } = setUp();
    autoFocusComposer(composer);
    expect(document.activeElement).toBe(composer);
    expect(composer.hasAttribute(AUTO_FOCUS_ATTR)).toBe(true);
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(composer.hasAttribute(AUTO_FOCUS_ATTR)).toBe(false);
  });
});

/** A composer whose message box mounts only when `ready` (a thread that loads slowly). */
function SlowComposer({ ready, threadKey = "t1" }: { ready: boolean; threadKey?: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useComposerAutoFocus(input, threadKey);
  return ready ? <textarea ref={input} aria-label="Slow message" /> : <p>Loading…</p>;
}

/** Mounts the message box `after` ms later. */
function Delayed({ after }: { after: number }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), after);
    return () => clearTimeout(timer);
  }, [after]);
  return <SlowComposer ready={ready} />;
}

describe(
  "a request waits for a composer that mounts late (KOBE-840 review)",
  { timeout: 10_000 },
  () => {
    const box = () => screen.queryByLabelText("Slow message");

    it("focuses the message box once it mounts, well after two frames", async () => {
      render(<Delayed after={400} />);
      await waitFor(() => expect(box()).not.toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(box()));
    });

    it("keeps the request across a remount of the composer", async () => {
      const { unmount } = render(<SlowComposer ready={false} />);
      await frames();
      unmount();
      render(<SlowComposer ready />);
      await waitFor(() => expect(document.activeElement).toBe(box()));
    });

    it("drops the request when the member opens a dialog meanwhile", async () => {
      const view = render(<SlowComposer ready={false} />);
      await frames();
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      await frames();
      dialog.remove();
      view.rerender(<SlowComposer ready />);
      await frames();
      expect(document.activeElement).not.toBe(box());
    });

    it("drops the request when the member presses a key meanwhile", async () => {
      const view = render(<SlowComposer ready={false} />);
      await frames();
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
      });
      view.rerender(<SlowComposer ready />);
      await frames();
      expect(document.activeElement).not.toBe(box());
    });

    it("drops the request after PENDING_REQUEST_MS", async () => {
      const start = performance.now();
      const now = vi.spyOn(performance, "now").mockReturnValue(start);
      const view = render(<SlowComposer ready={false} />);
      await frames();
      now.mockReturnValue(start + PENDING_REQUEST_MS + 1);
      await frames();
      view.rerender(<SlowComposer ready />);
      await frames();
      expect(document.activeElement).not.toBe(box());
    });
  },
);
