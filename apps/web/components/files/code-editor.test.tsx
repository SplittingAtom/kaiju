// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { documentCspNonce } from "../../lib/security/csp-nonce";
import { must } from "../../lib/testing/must";
import { LayoutPreferencesContext, type LayoutPreferencesApi } from "../../lib/shell/preferences";
import CodeEditor from "./code-editor";

/**
 * KOBE-469: the page CSP allows only nonced `<style>`, so every CodeMirror view carries the
 * document's nonce (EditorView.cspNonce) or the browser drops all of its styles.
 */
const NONCE = "test-nonce-469";

/** As the server sends it: the attribute, which the browser keeps as the `nonce` property. */
function addNoncedScript(nonce: string): HTMLScriptElement {
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  script.nonce = nonce;
  document.head.append(script);
  return script;
}

function viewIn(container: HTMLElement): EditorView {
  const editor = must(container.querySelector<HTMLElement>(".cm-editor"));
  return must(EditorView.findFromDOM(editor));
}

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

describe("documentCspNonce", () => {
  it("reads the nonce property of a nonced script (browsers hide the attribute)", () => {
    const script = addNoncedScript(NONCE);
    script.setAttribute("nonce", ""); // what nonce hiding leaves in the DOM
    script.nonce = NONCE;
    expect(documentCspNonce(document)).toBe(NONCE);
  });

  it("is empty when the page has no nonced script", () => {
    expect(documentCspNonce(document)).toBe("");
  });
});

describe("CodeEditor CSP nonce", () => {
  it("gives the plain editor the document's nonce", () => {
    addNoncedScript(NONCE);
    const { container } = render(<CodeEditor value="a\n" language={null} label="Edit a" />);
    expect(viewIn(container).state.facet(EditorView.cspNonce)).toBe(NONCE);
  });

  it("gives the unified merge view the document's nonce", () => {
    addNoncedScript(NONCE);
    const { container } = render(
      <CodeEditor value="a\nB\n" original="a\nb\n" language={null} label="Review a" />,
    );
    expect(viewIn(container).state.facet(EditorView.cspNonce)).toBe(NONCE);
  });
});

describe("CodeEditor notebook cell mode (KOBE-465)", () => {
  it("gives a compact cell the nonce, and Shift+Enter runs instead of inserting a line", () => {
    addNoncedScript(NONCE);
    let runs = 0;
    const { container } = render(
      <CodeEditor value="x = 1" language="python" label="Cell 1" compact onRun={() => runs++} />,
    );
    const view = viewIn(container);
    expect(view.state.facet(EditorView.cspNonce)).toBe(NONCE);
    const host = must(container.querySelector("[data-kobe-code-editor]"));
    expect(host.className).not.toContain("min-h-80");
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );
    expect(runs).toBe(1);
    expect(view.state.doc.toString()).toBe("x = 1");
  });
});

/** KOBE-805: Mod+Enter and Shift+Enter run, Mod+S saves; KOBE-804: go to an error's line. */
describe("CodeEditor run and save keys (KOBE-805)", () => {
  it("Mod+Enter runs all, Shift+Enter runs the selection when there is one, Mod+S saves", () => {
    const scopes: string[] = [];
    let saves = 0;
    const lines: unknown[] = [];
    const { container } = render(
      <CodeEditor
        value={"a = 1\nb = 2\nc = 3\n"}
        language="python"
        label="Edit a"
        onRun={(scope) => scopes.push(scope)}
        onSave={() => saves++}
        onSelectionLines={(l) => lines.push(l)}
      />,
    );
    const view = viewIn(container);
    press(view, "Enter", { ctrlKey: true });
    press(view, "Enter", { shiftKey: true });
    // Lines 2 and 3 selected (from line 2's start to the start of line 4: line 4 is left out).
    act(() => view.dispatch({ selection: { anchor: 6, head: 18 } }));
    expect(lines.at(-1)).toEqual({ start: 2, end: 3 });
    press(view, "Enter", { shiftKey: true });
    expect(scopes).toEqual(["all", "all", "selection"]);
    press(view, "s", { ctrlKey: true });
    expect(saves).toBe(1);
    expect(view.state.doc.toString()).toBe("a = 1\nb = 2\nc = 3\n");
    act(() => view.dispatch({ selection: { anchor: 2 } }));
    expect(lines.at(-1)).toBeNull();
  });

  it("without handlers, the keys do what CodeMirror does", () => {
    const { container } = render(<CodeEditor value="a" language={null} label="Edit a" />);
    const view = viewIn(container);
    act(() => view.dispatch({ selection: { anchor: 1 } }));
    press(view, "Enter", { shiftKey: true });
    expect(view.state.doc.toString()).not.toBe("a");
  });

  it("reveal moves the cursor to the start of the line, each time its seq changes", () => {
    const { container, rerender } = render(
      <CodeEditor value={"a\nbb\nccc\n"} language={null} label="Edit a" />,
    );
    const view = viewIn(container);
    rerender(
      <CodeEditor
        value={"a\nbb\nccc\n"}
        language={null}
        label="Edit a"
        reveal={{ line: 3, seq: 1 }}
      />,
    );
    expect(view.state.selection.main.head).toBe(5);
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    rerender(
      <CodeEditor
        value={"a\nbb\nccc\n"}
        language={null}
        label="Edit a"
        reveal={{ line: 99, seq: 2 }}
      />,
    );
    expect(view.state.selection.main.head).toBe(view.state.doc.line(view.state.doc.lines).from);
  });
});

/** KOBE-806: find, replace, go to line, wrap toggle and cursor position. */
function press(
  view: EditorView,
  key: string,
  mods: { ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods });
  return act(() => void runScopeHandlers(view, event, "editor"));
}

describe("CodeEditor find, replace and go to line (KOBE-806 ac-1)", () => {
  it("Mod+F opens the find panel, labelled, with Replace; Escape closes it", () => {
    const { container } = render(
      <CodeEditor value={"one\ntwo\nthree\n"} language={null} label="Edit a" />,
    );
    const view = viewIn(container);
    press(view, "f", { ctrlKey: true });
    expect(searchPanelOpen(view.state)).toBe(true);
    expect(screen.getByLabelText("Find")).toBeTruthy();
    expect(screen.getByLabelText("Replace")).toBeTruthy();
    expect(screen.getByRole("button", { name: "next" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "previous" })).toBeTruthy();
    press(view, "Escape");
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it("Mod+Alt+F opens it with the cursor in Replace; a read-only editor has no Replace", () => {
    const { container, unmount } = render(
      <CodeEditor value="a\n" language={null} label="Edit a" />,
    );
    press(viewIn(container), "f", { ctrlKey: true, altKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText("Replace"));
    unmount();
    const ro = render(<CodeEditor value="a\n" language={null} label="Edit a" readOnly />);
    press(viewIn(ro.container), "f", { ctrlKey: true });
    expect(screen.getByLabelText("Find")).toBeTruthy();
    expect(screen.queryByLabelText("Replace")).toBeNull();
  });

  it("find next moves to the next match and replace changes the text", async () => {
    const { container } = render(
      <CodeEditor value={"cat\ndog\ncat\n"} language={null} label="Edit a" />,
    );
    const view = viewIn(container);
    const user = userEvent.setup();
    press(view, "f", { ctrlKey: true });
    await user.type(screen.getByLabelText("Find"), "cat");
    press(view, "g", { ctrlKey: true });
    expect(view.state.selection.main.from).toBe(0);
    press(view, "g", { ctrlKey: true });
    expect(view.state.selection.main.from).toBe(8);
    await user.type(screen.getByLabelText("Replace"), "cow");
    await user.click(screen.getByRole("button", { name: "replace all" }));
    expect(view.state.doc.toString()).toBe("cow\ndog\ncow\n");
  });

  it("Mod+Alt+G opens a labelled Go to line field ", () => {
    // (Submitting moves the selection under happy-dom's selectionchange, which CodeMirror's
    // observer cannot take mid-update; the keyboard path to the dialog is what is checked.)
    const { container } = render(<CodeEditor value={"a\nb\nc\n"} language={null} label="Edit a" />);
    press(viewIn(container), "g", { ctrlKey: true, altKey: true });
    const field = must(document.querySelector<HTMLInputElement>(".cm-goto-line input[name=line]"));
    expect(field.closest("label")?.textContent).toContain("Go to line");
    expect((field as HTMLInputElement).value).toBe("1");
  });
});

function shellWith(saved: Record<string, unknown>[], editorLineWrap?: boolean) {
  const api: LayoutPreferencesApi = {
    preferences: editorLineWrap === undefined ? {} : { editorLineWrap },
    save: (change) => void saved.push(change as Record<string, unknown>),
  };
  return ({ children }: { children: ReactNode }) => (
    <LayoutPreferencesContext.Provider value={api}>{children}</LayoutPreferencesContext.Provider>
  );
}

describe("CodeEditor line wrap and position (KOBE-806 ac-2, ac-3)", () => {
  it("wraps by default; the toggle turns it off and the choice is saved", async () => {
    const saved: Record<string, unknown>[] = [];
    const { container } = render(<CodeEditor value="a\n" language={null} label="Edit a" />, {
      wrapper: shellWith(saved),
    });
    const view = viewIn(container);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
    const toggle = screen.getByRole("button", { name: "Wrap long lines" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await userEvent.setup().click(toggle);
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
    expect(
      screen.getByRole("button", { name: "Wrap long lines" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(saved).toEqual([{ editorLineWrap: false }]);
  });

  it("starts from the member's stored choice", () => {
    const { container } = render(<CodeEditor value="a\n" language={null} label="Edit a" />, {
      wrapper: shellWith([], false),
    });
    expect(viewIn(container).contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
  });

  it("shows the line and column of the cursor", () => {
    const { container } = render(<CodeEditor value={"ab\ncde\n"} language={null} label="Edit a" />);
    const view = viewIn(container);
    expect(screen.getByLabelText("Cursor position").textContent).toBe("Ln 1, Col 1");
    act(() => view.dispatch({ selection: { anchor: 5 } }));
    expect(screen.getByLabelText("Cursor position").textContent).toBe("Ln 2, Col 3");
  });
});

describe("CodeEditor autoFocus (KOBE-802)", () => {
  it("takes the cursor when asked", () => {
    const { container } = render(
      <CodeEditor value="a\n" language={null} label="Edit a" autoFocus />,
    );
    expect(viewIn(container).hasFocus).toBe(true);
  });

  it("never takes it from the composer or another text field being typed in", () => {
    const composer = document.createElement("textarea");
    document.body.append(composer);
    composer.focus();
    const { container } = render(
      <CodeEditor value="a\n" language={null} label="Edit a" autoFocus />,
    );
    expect(viewIn(container).hasFocus).toBe(false);
    expect(document.activeElement).toBe(composer);
    composer.remove();
  });

  it("the cursor position is a labelled status that does not announce", () => {
    render(<CodeEditor value="a\n" language={null} label="Edit a" />);
    const status = screen.getByRole("status", { name: "Cursor position" });
    expect(status.getAttribute("aria-live")).toBe("off");
  });
});
