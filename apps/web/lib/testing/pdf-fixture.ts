/**
 * A tiny, valid PDF built byte by byte (KOBE-801 tests): one page per string, Helvetica text, an
 * optional link annotation, or an `/Encrypt` dictionary whose user password is not empty (so
 * pdf.js asks for a password). The cross-reference table carries the real offsets.
 */
export interface PdfFixtureOptions {
  /** A URI link over the first page's text. */
  readonly link?: string | undefined;
  /** Add an encryption dictionary with a non-empty user password. */
  readonly encrypted?: boolean | undefined;
  /** A grey image XObject of this declared size on the first page (its data: one row at most). */
  readonly image?: { readonly width: number; readonly height: number } | undefined;
}

const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function pdfFixture(pages: readonly string[], options: PdfFixtureOptions = {}): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(""); // filled below, once the page tree's number is known
  const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  const img = options.image;
  const image = img
    ? add(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${Math.min(img.width * img.height, 4096)} >>\nstream\n${"\u007f".repeat(Math.min(img.width * img.height, 4096))}\nendstream`,
      )
    : null;
  pages.forEach((text, i) => {
    const draw = i === 0 && image !== null ? " q 200 0 0 200 72 400 cm /Im1 Do Q" : "";
    const stream = `BT /F1 24 Tf 72 700 Td (${escape(text)}) Tj ET${draw}`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots =
      i === 0 && options.link
        ? ` /Annots [${add(
            `<< /Type /Annot /Subtype /Link /Rect [72 690 400 730] /Border [0 0 0] /A << /S /URI /URI (${escape(options.link)}) >> >>`,
          )} 0 R]`
        : "";
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >>${image === null ? "" : ` /XObject << /Im1 ${image} 0 R >>`} >>${annots} >>`,
      ),
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const hex32 = (c: string) => `<${c.repeat(64)}>`;
  const encrypt = options.encrypted
    ? add(`<< /Filter /Standard /V 1 /R 2 /O ${hex32("a")} /U ${hex32("b")} /P -4 >>`)
    : null;

  let out = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, "0")} 00000 n \n`;
  const id = "<0123456789abcdef0123456789abcdef>";
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${
    encrypt === null ? "" : ` /Encrypt ${encrypt} 0 R`
  } /ID [${id} ${id}] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
