import { INVOICE_SELLER, type OrderInvoiceLine } from "@/lib/invoice-seller";

function money(n: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(n);
}

function formatInvoiceDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function safeFilePart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

/** Escape text for PDF literal strings (WinAnsi / PDFDocEncoding-ish ASCII). */
function pdfEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E]/g, "?");
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars) : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

type PdfOp = string;

/**
 * Minimal single-page (or multi-page) PDF writer — Helvetica only, no deps.
 */
function buildSimplePdf(pages: PdfOp[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };

  const fontObj = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBoldObj = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
  );

  const pageObjs: number[] = [];
  const contentObjs: number[] = [];

  for (const ops of pages) {
    const stream = ops.join("\n");
    // Length must be byte length of stream content (ASCII ops only).
    const content = add(
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
    contentObjs.push(content);
  }

  for (let i = 0; i < pages.length; i++) {
    const page = add(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] /Contents ${contentObjs[i]} 0 R /Resources << /Font << /F1 ${fontObj} 0 R /F2 ${fontBoldObj} 0 R >> >> >>`,
    );
    pageObjs.push(page);
  }

  const kids = pageObjs.map((n) => `${n} 0 R`).join(" ");
  const pagesObj = add(
    `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageObjs.length} >>`,
  );

  // Patch Parent refs in page objects (they were written as 0 0 R)
  for (let i = 0; i < pageObjs.length; i++) {
    const idx = pageObjs[i] - 1;
    objects[idx] = objects[idx].replace("/Parent 0 0 R", `/Parent ${pagesObj} 0 R`);
  }

  const catalog = add(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  const encoder = new TextEncoder();
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF`;

  return encoder.encode(pdf);
}

function textOps(
  font: "F1" | "F2",
  size: number,
  x: number,
  y: number,
  text: string,
): PdfOp[] {
  return [
    "BT",
    `/${font} ${size} Tf`,
    `${x.toFixed(2)} ${y.toFixed(2)} Td`,
    `(${pdfEscape(text)}) Tj`,
    "ET",
  ];
}

/**
 * Build and download a basic PDF invoice for an Amazon order.
 * Includes all provided lines (caller should pass every line for that orderId).
 */
export function downloadOrderInvoicePdf(
  lines: OrderInvoiceLine[],
  currency: string,
): void {
  if (lines.length === 0) return;

  const orderId = lines[0].orderId;
  const orderDate = lines
    .map((l) => l.orderDate)
    .filter(Boolean)
    .sort()[0] ?? lines[0].orderDate;
  const fulfillment =
    lines.find((l) => l.fulfillmentType)?.fulfillmentType ?? null;

  const pageW = 595;
  const pageH = 842;
  const margin = 50;
  const lineH = 12;
  const maxY = 60;

  const pages: PdfOp[][] = [];
  let ops: PdfOp[] = [];
  let y = pageH - margin;

  const newPage = () => {
    pages.push(ops);
    ops = [];
    y = pageH - margin;
  };

  const ensure = (need: number) => {
    if (y - need < maxY) newPage();
  };

  const write = (font: "F1" | "F2", size: number, text: string, x = margin) => {
    ensure(size + 4);
    ops.push(...textOps(font, size, x, y, text));
    y -= size + 4;
  };

  write("F2", 18, "INVOICE");
  y -= 4;
  write("F2", 11, INVOICE_SELLER.legalName);
  for (const line of INVOICE_SELLER.addressLines) {
    write("F1", 9, line);
  }
  write("F1", 9, `Company number: ${INVOICE_SELLER.companyNumber}`);
  y -= 8;

  write("F2", 10, "Bill to");
  write("F1", 9, "Amazon Marketplace customer");
  write(
    "F1",
    9,
    fulfillment === "FBA"
      ? "Fulfilled by Amazon (FBA)"
      : fulfillment === "FBM"
        ? "Fulfilled by merchant (FBM)"
        : "Sold via Amazon Marketplace",
  );
  y -= 10;

  write("F2", 9, "Invoice / order ref");
  write("F1", 9, orderId);
  write("F2", 9, "Order date");
  write("F1", 9, formatInvoiceDate(orderDate));
  y -= 8;

  // Table header
  ensure(20);
  ops.push(...textOps("F2", 9, margin, y, "Description"));
  ops.push(...textOps("F2", 9, margin + 260, y, "SKU"));
  ops.push(...textOps("F2", 9, pageW - margin - 90, y, "Qty"));
  ops.push(...textOps("F2", 9, pageW - margin - 50, y, "Amount"));
  y -= 4;
  ops.push(`${margin} ${y} m`);
  ops.push(`${pageW - margin} ${y} l`);
  ops.push("S");
  y -= 14;

  let subtotal = 0;
  for (const line of lines) {
    const unit = Number(line.salePrice) || 0;
    const qty = Math.max(0, Number(line.quantity) || 0);
    const amount = Math.round(unit * qty * 100) / 100;
    subtotal += amount;
    const title = (line.title ?? line.sku ?? "Item").trim();
    const descLines = wrapText(title, 42);
    const block = Math.max(descLines.length, 1) * lineH + (line.asin ? lineH : 0) + 4;
    ensure(block);

    let dy = y;
    for (const dl of descLines) {
      ops.push(...textOps("F1", 8, margin, dy, dl));
      dy -= lineH;
    }
    if (line.asin) {
      ops.push(...textOps("F1", 7, margin, dy, `ASIN ${line.asin}`));
    }
    ops.push(...textOps("F1", 8, margin + 260, y, line.sku || "-"));
    ops.push(
      ...textOps("F1", 8, pageW - margin - 90, y, String(qty)),
    );
    ops.push(
      ...textOps("F1", 8, pageW - margin - 50, y, money(amount, currency)),
    );
    y -= block;
  }

  ensure(40);
  ops.push(`${margin} ${y} m`);
  ops.push(`${pageW - margin} ${y} l`);
  ops.push("S");
  y -= 16;
  ops.push(...textOps("F2", 11, pageW - margin - 140, y, "Total"));
  ops.push(
    ...textOps("F2", 11, pageW - margin - 50, y, money(subtotal, currency)),
  );
  y -= 24;

  const notes = [
    "This is a basic sales invoice for record-keeping.",
    "Amounts reflect the Amazon order line sale price as recorded in SellerBunker.",
    "VAT: not charged on this invoice (seller not shown as VAT-registered here).",
    `Registered office: ${INVOICE_SELLER.registeredOffice}`,
  ];
  for (const note of notes) {
    for (const wl of wrapText(note, 90)) {
      write("F1", 8, wl);
    }
  }

  pages.push(ops);

  const bytes = buildSimplePdf(pages);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `invoice-${safeFilePart(orderId)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
