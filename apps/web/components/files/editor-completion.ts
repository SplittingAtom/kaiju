/**
 * Code completion in the Raw editor (KOBE-808). Built in, for every editable code file: CodeMirror's
 * autocompletion with the language packages' own sources (Python keywords, snippets, builtins and
 * the file's names; JavaScript/TypeScript keywords, snippets and local names; see
 * `editor-languages.ts`). It opens while typing a name and on Ctrl+Space; Enter or Tab accepts,
 * Escape closes; never in a read-only view. For a `.py` file with a {@link KernelCompleter}, the
 * conversation's running kernel adds its own matches (live variables, attributes, DataFrame
 * columns, module members) above the built-in ones, signature help while typing a call's
 * arguments, and docstrings on hover or Ctrl+Shift+Space. Everything the kernel sends is shown as
 * text (`textContent`), never as HTML.
 */
import {
  acceptCompletion,
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  hoverTooltip,
  keymap,
  showTooltip,
  ViewPlugin,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import {
  DOC_NAME,
  WINDOW_AFTER,
  WINDOW_BEFORE,
  type KernelCompleter,
  type KernelDoc,
} from "../../lib/notebooks/kernel-completer";

/** Wait this long after a keystroke before asking the kernel (a later keystroke cancels it). */
export const KERNEL_DEBOUNCE_MS = 150;
/** Kernel matches rank above the built-in ones. */
const KERNEL_BOOST = 50;

/** Built-in completion for an editable view: the language's own sources, standard keys. */
export function builtInCompletion(): Extension {
  return [
    // Its default keymap: Ctrl+Space (on a Mac also Alt+I), arrows, Enter accepts, Escape closes.
    autocompletion({ activateOnTyping: true, icons: true }),
    // Tab accepts an open completion; otherwise Tab moves focus as before (never trapped).
    Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
  ];
}

/** The code sent around `pos`: whole lines before it (up to a cap), its line to the end. */
export function completionWindow(doc: Text, pos: number): { start: number; code: string } {
  const start = doc.lineAt(Math.max(0, pos - WINDOW_BEFORE)).from;
  const end = Math.min(doc.lineAt(pos).to, pos + WINDOW_AFTER);
  return { start, code: doc.sliceString(start, end) };
}

const KIND: Readonly<Record<string, string>> = {
  function: "function",
  instance: "variable",
  variable: "variable",
  statement: "variable",
  attribute: "property",
  property: "property",
  "dict key": "property",
  module: "namespace",
  class: "class",
  keyword: "keyword",
  magic: "keyword",
  path: "text",
};

/** Waits `ms`, or less when the query is aborted (then false). */
function settle(ctx: CompletionContext, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!ctx.aborted), ms);
    ctx.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Labels the language's own (synchronous) sources give here, so the kernel adds no duplicates. */
function builtInLabels(ctx: CompletionContext, self: CompletionSource): Set<string> {
  const labels = new Set<string>();
  for (const source of ctx.state.languageDataAt<unknown>("autocomplete", ctx.pos)) {
    if (source === self || typeof source !== "function") continue;
    try {
      const got = (source as CompletionSource)(ctx);
      if (got && !(got instanceof Promise)) for (const o of got.options) labels.add(o.label);
    } catch {
      // A built-in source's own failure only costs the de-duplication.
    }
  }
  return labels;
}

/**
 * The kernel's completions as a CodeMirror source: after a name, a dot or a quote (or on
 * Ctrl+Space), debounced, cancelled by the next query, null whenever the kernel can't answer.
 */
export function kernelCompletionSource(completer: KernelCompleter): CompletionSource {
  const source: CompletionSource = async (ctx): Promise<CompletionResult | null> => {
    const before = ctx.matchBefore(/(?:[\w.]+|\[["'][^"'\]\n]*)$/);
    if (!ctx.explicit && before === null) return null;
    if (!completer.available()) return null;
    if (!(await settle(ctx, KERNEL_DEBOUNCE_MS))) return null;
    const ctrl = new AbortController();
    ctx.addEventListener("abort", () => ctrl.abort());
    const { start, code } = completionWindow(ctx.state.doc, ctx.pos);
    const got = await completer.complete(code, ctx.pos - start, ctrl.signal);
    if (got === null || got.matches.length === 0 || ctx.aborted) return null;
    const known = builtInLabels(ctx, source);
    const options: Completion[] = got.matches
      .filter((m) => !known.has(m.label))
      .map((m) => ({
        label: m.label,
        boost: KERNEL_BOOST,
        detail: "kernel",
        ...(m.type !== undefined ? { type: KIND[m.type] ?? "variable" } : {}),
      }));
    if (options.length === 0) return null;
    return { from: start + got.from, to: start + got.to, options, validFor: /^\w*$/ };
  };
  return source;
}

/** The dotted name of the call whose arguments hold `pos` (Python syntax tree), if any. */
export function calleeAt(state: EditorState, pos: number): { name: string; at: number } | null {
  for (let node = syntaxTree(state).resolveInner(pos, -1); node.parent; node = node.parent) {
    if (node.name !== "ArgList") continue;
    const call = node.parent;
    if (call.name !== "CallExpression" || pos <= node.from) return null;
    const closed = state.sliceDoc(node.to - 1, node.to) === ")";
    if (closed && pos >= node.to) continue;
    const callee = call.firstChild;
    if (!callee || callee === node) return null;
    const name = state.sliceDoc(callee.from, callee.to);
    return DOC_NAME.test(name) ? { name, at: node.from } : null;
  }
  return null;
}

/** The dotted name ending at the end of the word at `pos` (`pd.read_csv` on `read`), if any. */
export function nameAt(
  state: EditorState,
  pos: number,
): { name: string; from: number; to: number } | null {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  let end = pos - line.from;
  while (end < text.length && /\w/.test(text.charAt(end))) end++;
  let start = pos - line.from;
  while (start > 0 && /[\w.]/.test(text.charAt(start - 1))) start--;
  const name = text.slice(start, end).replace(/^\.+/, "");
  if (!DOC_NAME.test(name)) return null;
  return { name, from: line.from + end - name.length, to: line.from + end };
}

/** The documentation as plain text nodes: the signature, then the docstring. */
export function docTooltipDom(doc: KernelDoc): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-kobe-doc";
  dom.setAttribute("role", "tooltip");
  if (doc.signature !== undefined) {
    const sig = document.createElement("div");
    sig.className = "cm-kobe-doc-signature";
    sig.textContent = doc.signature;
    dom.append(sig);
  }
  if (doc.doc !== undefined) {
    const body = document.createElement("div");
    body.className = "cm-kobe-doc-body";
    body.textContent = doc.doc;
    dom.append(body);
  }
  return dom;
}

interface SignatureHelp {
  readonly name: string;
  readonly at: number;
  readonly doc: KernelDoc;
  /** Full docs (the shortcut), or the signature only (typing a call). */
  readonly full: boolean;
}

const setHelp = StateEffect.define<SignatureHelp | null>();

const helpField = StateField.define<SignatureHelp | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHelp)) return e.value;
    if (value === null || (!tr.docChanged && !tr.selection)) return value;
    // Kept while the cursor stays in the call's arguments (or, for the shortcut, on the name).
    const head = tr.state.selection.main.head;
    const still =
      calleeAt(tr.state, head)?.name === value.name ||
      (value.full && nameAt(tr.state, head)?.name === value.name);
    return still ? { ...value, at: tr.changes.mapPos(value.at) } : null;
  },
  provide: (field) =>
    showTooltip.from(field, (help): Tooltip | null =>
      help === null
        ? null
        : {
            pos: help.at,
            above: true,
            strictSide: false,
            create: () => ({
              dom: docTooltipDom(help.full ? help.doc : { signature: help.doc.signature }),
            }),
          },
    ),
});

/**
 * Signature help: typing `(` or `,` in a call asks the kernel for the callee's signature (after a
 * debounce; a newer request cancels an older one) and shows it above the call until the cursor
 * leaves its arguments, or Escape.
 */
function signatureHelp(completer: KernelCompleter): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      #ctrl: AbortController | null = null;
      #timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        let typed = "";
        update.changes.iterChanges((_a, _b, _c, _d, inserted) => (typed = inserted.toString()));
        if (typed !== "(" && typed !== ",") return;
        this.ask(false);
      }
      ask(full: boolean) {
        this.cancel();
        const state = this.view.state;
        const head = state.selection.main.head;
        const target = calleeAt(state, head) ?? (full ? nameAt(state, head) : null);
        if (target === null || !completer.available()) return;
        const at = "at" in target ? target.at : target.from;
        const ctrl = new AbortController();
        this.#ctrl = ctrl;
        this.#timer = setTimeout(
          () => {
            void completer.doc(target.name, ctrl.signal).then((doc) => {
              if (ctrl.signal.aborted || doc === null) return;
              if (!full && doc.signature === undefined) return;
              this.view.dispatch({ effects: setHelp.of({ name: target.name, at, doc, full }) });
            });
          },
          full ? 0 : KERNEL_DEBOUNCE_MS,
        );
      }
      cancel() {
        clearTimeout(this.#timer);
        this.#ctrl?.abort();
        this.#ctrl = null;
      }
      destroy() {
        this.cancel();
      }
    },
  );
  const show = (view: EditorView) => {
    view.plugin(plugin)?.ask(true);
    return true;
  };
  const close = (view: EditorView) => {
    if (view.state.field(helpField, false) == null) return false;
    view.dispatch({ effects: setHelp.of(null) });
    return true;
  };
  return [
    helpField,
    plugin,
    keymap.of([
      { key: "Ctrl-Shift-Space", run: show },
      { key: "Escape", run: close },
    ]),
  ];
}

/** Docstrings on hover over a name (after CodeMirror's hover delay). */
function hoverDocs(completer: KernelCompleter): Extension {
  return hoverTooltip(
    async (view, pos) => {
      const target = nameAt(view.state, pos);
      if (target === null || !completer.available()) return null;
      const doc = await completer.doc(target.name);
      if (doc === null) return null;
      return {
        pos: target.from,
        end: target.to,
        above: true,
        create: () => ({ dom: docTooltipDom(doc) }),
      };
    },
    { hoverTime: 500 },
  );
}

/** Kernel completion, signature help and docs for an editable `.py` view. */
export function kernelCompletion(completer: KernelCompleter): Extension {
  // One source for the view's life: CodeMirror tracks a running query by its source.
  const source = kernelCompletionSource(completer);
  const data = [{ autocomplete: source }];
  return [EditorState.languageData.of(() => data), signatureHelp(completer), hoverDocs(completer)];
}

/** The completion list and the docs tooltips in the theme's tokens, light and dark. */
export const completionTheme = EditorView.theme({
  ".cm-tooltip": {
    backgroundColor: "var(--popover, var(--background))",
    color: "var(--popover-foreground, var(--foreground))",
    border: "1px solid var(--border)",
    borderRadius: "0.375rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--kobe-font-mono)",
    maxHeight: "14rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "color-mix(in srgb, var(--ring) 30%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-kobe-doc": {
    maxWidth: "36rem",
    maxHeight: "14rem",
    overflow: "auto",
    padding: "0.375rem 0.5rem",
    fontSize: "0.75rem",
  },
  ".cm-kobe-doc-signature": { fontFamily: "var(--kobe-font-mono)", whiteSpace: "pre-wrap" },
  ".cm-kobe-doc-body": {
    whiteSpace: "pre-wrap",
    color: "var(--muted-foreground)",
    marginTop: "0.25rem",
  },
});
