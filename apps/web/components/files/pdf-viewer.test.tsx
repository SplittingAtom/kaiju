// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTextLayer, openPdf, type PdfDocument, type PdfLoad } from "../../lib/files/pdfjs";
import { IconActionProvider } from "../shell/icon-action";
import PdfViewer from "./pdf-viewer";

/** KOBE-801: the PDF viewer, with pdf.js replaced at its module boundary. */
vi.mock("../../lib/files/pdfjs", () => ({ openPdf: vi.fn(), createTextLayer: vi.fn() }));

interface FakeAnnotation {
  readonly subtype: string;
  readonly rect: number[];
  readonly url?: string;
  readonly dest?: unknown;
}

let renders: number[];
let destroyed: number;

function fakeDoc(pages: readonly (readonly string[])[], annotations: FakeAnnotation[] = []) {
  return {
    numPages: pages.length,
    getPage: async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
        scale,
        convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale],
      }),
      render: () => {
        renders.push(n);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
      getTextContent: async () => ({
        items: (pages[n - 1] ?? []).map((str) => ({ str, hasEOL: false })),
        styles: {},
      }),
      getAnnotations: async () => (n === 1 ? annotations : []),
    }),
    getDestination: async () => [{ num: 7, gen: 0 }],
    getPageIndex: async () => 2,
  } as unknown as PdfDocument;
}

function opens(result: Promise<PdfDocument>) {
  vi.mocked(openPdf).mockImplementation((): PdfLoad => ({
    promise: result,
    destroy: async () => {
      destroyed += 1;
    },
  }));
}

beforeEach(() => {
  renders = [];
  destroyed = 0;
  vi.mocked(createTextLayer).mockImplementation(async ({ textContentSource, container }) => {
    const spans: HTMLElement[] = [];
    return {
      render: async () => {
        const content = textContentSource as { items: { str: string }[] };
        for (const item of content.items) {
          const span = document.createElement("span");
          span.textContent = item.str;
          container.append(span);
          spans.push(span);
        }
      },
      cancel: () => {},
      get textDivs() {
        return spans;
      },
    };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const bytes = new Uint8Array([37, 80, 68, 70]);

function show(onDownload = vi.fn()) {
  const view = render(
    <IconActionProvider>
      <PdfViewer bytes={bytes} name="doc.pdf" onDownload={onDownload} />
    </IconActionProvider>,
  );
  return { ...view, onDownload };
}

const pageField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Page number" });
const zoomText = () => screen.getByRole("status", { name: "Zoom" }).textContent;

describe("PDF viewer (ac-2)", () => {
  it("shows the pages with selectable text, the count and the toolbar", async () => {
    opens(Promise.resolve(fakeDoc([["Alpha ", "report"], ["Beta"], ["Gamma"]])));
    show();
    const first = await screen.findByRole("group", { name: "Page 1 of 3" });
    await waitFor(() => expect(first.getAttribute("data-rendered")).toBe("true"));
    expect(await within(first).findByText("report")).toBeTruthy();
    expect(screen.getByText("of 3")).toBeTruthy();
    expect(pageField().value).toBe("1");
    expect(screen.getByRole("region", { name: "doc.pdf, page 1 of 3" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "PDF controls" })).toBeTruthy();
    // Fit to width is the default.
    expect(screen.getByRole("button", { name: "Fit to width" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(openPdf).toHaveBeenCalledWith(bytes);
  });

  it("renders only the pages near the view (a long file stays light)", async () => {
    opens(Promise.resolve(fakeDoc(Array.from({ length: 60 }, (_, i) => [`p${i + 1}`]))));
    show();
    await screen.findByRole("group", { name: "Page 60 of 60" });
    await waitFor(() => expect(renders.length).toBeGreaterThan(0));
    expect(Math.max(...renders)).toBeLessThanOrEqual(3);
  });

  it("next, previous and the page field move between pages", async () => {
    opens(Promise.resolve(fakeDoc([["a"], ["b"], ["c"]])));
    show();
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "Page 1 of 3" });
    const previous = screen.getByRole("button", { name: "Previous page" });
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(pageField().value).toBe("2");
    await user.clear(pageField());
    await user.type(pageField(), "9{Enter}");
    expect(pageField().value).toBe("3");
    expect(screen.getByRole("region", { name: "doc.pdf, page 3 of 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    await user.clear(pageField());
    await user.type(pageField(), "nope{Enter}");
    expect(pageField().value).toBe("3");
  });

  it("zoom in and out, fit page and fit width, by mouse and keys", async () => {
    opens(Promise.resolve(fakeDoc([["a"]])));
    show();
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "Page 1 of 1" });
    const fitWidth = screen.getByRole("button", { name: "Fit to width" });
    await user.click(screen.getByRole("button", { name: "Fit page" }));
    expect(screen.getByRole("button", { name: "Fit page" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(fitWidth.getAttribute("aria-pressed")).toBe("false");
    // The test's column has no size, so a fit is the smallest zoom; zoom in steps up from it.
    expect(zoomText()).toBe("25%");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(zoomText()).toBe("33%");
    await user.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(zoomText()).toBe("25%");
    screen.getByRole("region", { name: /doc\.pdf/ }).focus();
    await user.keyboard("{Control>}={/Control}");
    expect(zoomText()).toBe("33%");
    await user.keyboard("{Control>}0{/Control}");
    expect(fitWidth.getAttribute("aria-pressed")).toBe("true");
  });

  it("find: Mod+F, the match count, Enter and Shift+Enter, highlights, Escape", async () => {
    opens(Promise.resolve(fakeDoc([["Beta one"], ["none"], ["two ", "be", "ta"]])));
    show();
    const user = userEvent.setup();
    await screen.findByRole("group", { name: "Page 1 of 3" });
    screen.getByRole("region", { name: /doc\.pdf/ }).focus();
    await user.keyboard("{Control>}f{/Control}");
    const input = screen.getByRole("searchbox", { name: "Find in document" });
    expect(document.activeElement).toBe(input);
    await user.type(input, "BETA");
    const bar = screen.getByRole("search", { name: "Find in document" });
    await waitFor(() => expect(within(bar).getByRole("status").textContent).toBe("1 of 2"));
    const first = screen.getByRole("group", { name: "Page 1 of 3" });
    await waitFor(() => expect(within(first).getByText("Beta one").className).not.toBe(""));
    await user.keyboard("{Enter}");
    expect(within(bar).getByRole("status").textContent).toBe("2 of 2");
    expect(pageField().value).toBe("3");
    // The match spans two text items: both are marked.
    const third = screen.getByRole("group", { name: "Page 3 of 3" });
    await waitFor(() => expect(within(third).getByText("be").className).not.toBe(""));
    expect(within(third).getByText("ta").className).not.toBe("");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(within(bar).getByRole("status").textContent).toBe("1 of 2");
    await user.clear(input);
    await user.type(input, "zzz");
    await waitFor(() => expect(within(bar).getByRole("status").textContent).toBe("No matches"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
  });
});

describe("links inside the PDF (ac-3)", () => {
  it("web links open like the chat's links; script links are not drawn; inner links jump", async () => {
    opens(
      Promise.resolve(
        fakeDoc(
          [["a"], ["b"], ["c"]],
          [
            { subtype: "Link", rect: [72, 690, 400, 730], url: "https://example.com/x" },
            { subtype: "Link", rect: [72, 600, 400, 640], url: "javascript:alert(1)" },
            { subtype: "Link", rect: [72, 500, 400, 540], dest: "chapter-3" },
            { subtype: "Widget", rect: [0, 0, 10, 10] },
          ],
        ),
      ),
    );
    show();
    const user = userEvent.setup();
    const link = await screen.findByRole("link", { name: "Link: https://example.com/x" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Go to the linked place in this document" }),
    );
    await waitFor(() => expect(pageField().value).toBe("3"));
  });
});

describe("files the viewer cannot open (ac-4)", () => {
  it("a password-protected file says so, with Download", async () => {
    opens(Promise.reject(Object.assign(new Error("x"), { name: "PasswordException" })));
    const { onDownload } = show();
    expect(await screen.findByText(/password-protected/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Download" }));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("a broken file says it could not be read", async () => {
    opens(Promise.reject(Object.assign(new Error("x"), { name: "InvalidPDFException" })));
    show();
    expect(await screen.findByText(/could not be read as a PDF/)).toBeTruthy();
    expect(screen.getByText(/Use Download to get it/)).toBeTruthy();
  });
});

describe("memory", () => {
  it("closing the viewer, or another file in it, frees the document", async () => {
    opens(Promise.resolve(fakeDoc([["a"]])));
    const { rerender, unmount } = show();
    await screen.findByRole("group", { name: "Page 1 of 1" });
    rerender(
      <IconActionProvider>
        <PdfViewer bytes={new Uint8Array([1])} name="doc.pdf" />
      </IconActionProvider>,
    );
    expect(destroyed).toBe(1);
    await act(async () => unmount());
    expect(destroyed).toBe(2);
  });
});
