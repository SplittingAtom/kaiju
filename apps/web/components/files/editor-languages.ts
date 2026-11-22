/**
 * The Raw view's language modes (KOBE-463), each loaded only when a file of that kind opens.
 * Imported only by `code-editor.tsx`, itself loaded lazily, so none of it is in the chat bundle.
 * KOBE-808: Python and JavaScript/TypeScript come with their packages' completion sources
 * (keywords, snippets, builtins, the file's own names); JSX/TSX without the packages' tag
 * auto-closing, which would change what typing inserts. The other modes have no source.
 */
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { EditorLanguage } from "../../lib/files/editor";

/** CSV/TSV: quoted fields as strings, the delimiter as punctuation, numbers as numbers. */
function delimited(delimiter: string): StreamParser<{ quoted: boolean }> {
  return {
    name: delimiter === "\t" ? "tsv" : "csv",
    startState: () => ({ quoted: false }),
    token(stream, state) {
      if (state.quoted || stream.peek() === '"') {
        if (!state.quoted) stream.next();
        state.quoted = true;
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === '"' && !stream.eat('"')) {
            state.quoted = false;
            break;
          }
        }
        return "string";
      }
      if (stream.eat(delimiter)) return "punctuation";
      if (stream.match(/^-?\d+(\.\d+)?(?=$|[\t,])/)) return "number";
      while (!stream.eol() && stream.peek() !== delimiter) stream.next();
      return null;
    },
  };
}

export async function languageExtension(language: EditorLanguage | null): Promise<Extension> {
  switch (language) {
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "json":
      return (await import("@codemirror/lang-json")).jsonLanguage;
    case "csv":
      return StreamLanguage.define(delimited(","));
    case "tsv":
      return StreamLanguage.define(delimited("\t"));
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "javascript":
    case "jsx":
    case "typescript":
    case "tsx": {
      const js = await import("@codemirror/lang-javascript");
      const typescript = language === "typescript" || language === "tsx";
      // The completion sources sit on the shared JavaScript language data, so they apply to every
      // dialect; `jsx` stays off to leave out tag auto-closing.
      const support = js.javascript({ typescript }).support;
      const dialect = {
        javascript: js.javascriptLanguage,
        jsx: js.jsxLanguage,
        typescript: js.typescriptLanguage,
        tsx: js.tsxLanguage,
      }[language];
      return [dialect, support];
    }
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yamlLanguage;
    case null:
      return [];
  }
}
