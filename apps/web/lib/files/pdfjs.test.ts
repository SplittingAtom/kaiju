// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { pdfFixture } from "../testing/pdf-fixture";
import { documentOptions, openPdf, pdfAssetsBase } from "./pdfjs";
import { findInItems, pdfErrorKind } from "./viewer";

/** KOBE-801: the real pdf.js on tiny real files, its worker running in this thread. */
beforeAll(async () => {
  // Registers `globalThis.pdfjsWorker`, which pdf.js uses instead of starting a worker.
  // @ts-expect-error -- pdfjs-dist ships no types for its worker module
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
});

const failure = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("openPdf", () => {
  it("opens a file from its bytes and reads its text, which find searches", async () => {
    const load = openPdf(pdfFixture(["Quarterly report", "Second page here"]));
    const doc = await load.promise;
    expect(doc.numPages).toBe(2);
    const page = await doc.getPage(2);
    const content = await page.getTextContent();
    const items = content.items.flatMap((i) => ("str" in i ? [i.str] : []));
    expect(items.join("")).toContain("Second page here");
    expect(findInItems(items, "PAGE")).toHaveLength(1);
    await load.destroy();
  });

  it("reads a link annotation's URL (the viewer draws its own link)", async () => {
    const load = openPdf(pdfFixture(["Click"], { link: "https://example.com/x" }));
    const page = await (await load.promise).getPage(1);
    const annots = (await page.getAnnotations()) as { subtype: string; url?: string }[];
    expect(annots.find((a) => a.subtype === "Link")?.url).toBe("https://example.com/x");
    await load.destroy();
  });

  it("a password-protected file and a broken one fail with their own kind", async () => {
    const locked = openPdf(pdfFixture(["Secret"], { encrypted: true }));
    expect(pdfErrorKind(await failure(locked.promise))).toBe("password");
    await locked.destroy();
    const broken = openPdf(new TextEncoder().encode("%PDF-1.7\nnot really a pdf"));
    expect(pdfErrorKind(await failure(broken.promise))).toBe("invalid");
    await broken.destroy();
  });

  it("drops an image over the size cap (no allocation) and still draws the page", async () => {
    const ops = async (width: number, height: number) => {
      const load = openPdf(pdfFixture(["With image"], { image: { width, height } }));
      const page = await (await load.promise).getPage(1);
      const list = await page.getOperatorList();
      await load.destroy();
      return list.fnArray;
    };
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    expect(await ops(64, 64)).toContain(OPS.paintImageXObject);
    const bomb = await ops(60_000, 60_000);
    expect(bomb).not.toContain(OPS.paintImageXObject);
    expect(bomb).toContain(OPS.showText);
  });

  it("leaves the caller's bytes intact (pdf.js transfers a copy to its worker)", async () => {
    const bytes = pdfFixture(["Keep"]);
    const load = openPdf(bytes);
    await load.promise;
    expect(bytes.byteLength).toBeGreaterThan(0);
    await load.destroy();
  });
});

describe("documentOptions", () => {
  it("loads only from this origin, without WebAssembly or XFA, from bytes not a URL", () => {
    const base = pdfAssetsBase("6.5.438");
    expect(base).toBe("/pdfjs/6.5.438/");
    const options = documentOptions(new Uint8Array([1]), base);
    expect(options).toMatchObject({
      cMapUrl: "/pdfjs/6.5.438/cmaps/",
      wasmUrl: "/pdfjs/6.5.438/wasm/",
      useWasm: false,
      enableXfa: false,
      maxImageSize: 4096 * 4096,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    expect(options.url).toBeUndefined();
    expect(options.standardFontDataUrl).toBeUndefined();
  });
});
