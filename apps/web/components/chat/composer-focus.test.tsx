// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_FOCUS_ATTR,
  autoFocusComposer,
  focusRequest,
  focusVerdict,
  isTypingField,
} from "../../lib/chat/composer-focus";
import { FakeKaiju } from "../../lib/chat/testing/fake-kaiju";
import { openApp, threadGroup } from "./testing";
import { resetComposerFocusForTests } from "./use-composer-focus";

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
    expect(focusVerdict(document, null)).toBe("skip");
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
