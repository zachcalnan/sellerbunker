export type CogsBulkField =
  | "asin"
  | "sku"
  | "unitCostIncVat"
  | "purchaseDate"
  | "supplier"
  | "supplierLink"
  | "shipmentId"
  | "qtyPurchased"
  | "qtyDelivered"
  | "currency"
  | "vatRatePct"
  | "deliveryCostIncVat"
  | "prepCostIncVat"
  | "fulfilment"
  | "bundleSize"
  | "orderNumber";

export const COGS_BULK_FIELD_META: {
  id: CogsBulkField;
  label: string;
  required: boolean;
  aliases: string[];
}[] = [
  {
    id: "asin",
    label: "ASIN",
    required: false,
    aliases: [
      "asin",
      "asin1",
      "amazon asin",
      "product asin",
      "asin code",
      "asincode",
    ],
  },
  {
    id: "sku",
    label: "SKU (optional)",
    required: false,
    aliases: [
      "sku",
      "seller sku",
      "merchant sku",
      "amazon sku",
      "msku",
      "seller-sku",
    ],
  },
  {
    id: "unitCostIncVat",
    label: "Unit cost (inc VAT)",
    required: true,
    aliases: [
      "cost",
      "unit cost",
      "cogs",
      "unit cost inc vat",
      "purchase cost",
      "unit_cost",
      "cost per unit",
      "unit price",
      "£/unit",
      "£ / unit",
      "/unit",
      "per unit",
      "gbp/unit",
      "$/unit",
    ],
  },
  {
    id: "purchaseDate",
    label: "Purchase date",
    required: false,
    aliases: [
      "purchase date",
      "purchased date",
      "date purchased",
      "order date",
      "date",
    ],
  },
  {
    id: "supplier",
    label: "Supplier",
    required: false,
    aliases: ["supplier", "vendor", "store"],
  },
  {
    id: "supplierLink",
    label: "Supplier link",
    required: false,
    aliases: ["supplier link", "supplierlink", "url", "link"],
  },
  {
    id: "shipmentId",
    label: "Shipment ID",
    required: false,
    aliases: [
      "shipment id",
      "shipment",
      "shipmentid",
      "fba shipment",
      "tracking",
      "tracking #",
      "tracking number",
    ],
  },
  {
    id: "qtyPurchased",
    label: "Qty purchased",
    required: false,
    aliases: [
      "qty purchased",
      "quantity",
      "qty",
      "units purchased",
      "units",
    ],
  },
  {
    id: "qtyDelivered",
    label: "Qty delivered",
    required: false,
    aliases: ["qty delivered", "delivered", "units delivered"],
  },
  {
    id: "currency",
    label: "Currency",
    required: false,
    aliases: ["currency", "curr"],
  },
  {
    id: "vatRatePct",
    label: "VAT rate %",
    required: false,
    aliases: ["vat rate", "vat %", "vat", "vatrate"],
  },
  {
    id: "deliveryCostIncVat",
    label: "Delivery (inc VAT)",
    required: false,
    aliases: [
      "delivery",
      "delivery cost",
      "shipping",
      "delivery inc vat",
      "to amz",
      "to amazon",
      "inbound",
    ],
  },
  {
    id: "prepCostIncVat",
    label: "Prep (inc VAT)",
    required: false,
    aliases: [
      "prep",
      "prep cost",
      "prep inc vat",
      "home/prep",
      "home prep",
      "home & prep",
    ],
  },
  {
    id: "fulfilment",
    label: "Fulfilment",
    required: false,
    aliases: ["fulfilment", "fulfillment", "fba/fbm", "channel"],
  },
  {
    id: "bundleSize",
    label: "Bundle size",
    required: false,
    aliases: ["bundle size", "bundle", "pack size"],
  },
  {
    id: "orderNumber",
    label: "Order number",
    required: false,
    aliases: [
      "order number",
      "order #",
      "order no",
      "order num",
      "po",
    ],
  },
];

export const COGS_BULK_INFO =
  "Supported files: Excel (.xlsx, .xls) or tab-separated / comma-separated text (.tsv, .csv, .txt). " +
  "The first row must be headers. Required: ASIN + unit cost (e.g. ASIN and £/Unit, or Cost). " +
  "Optional: Date, Order Num, Units, Delivered, Supplier, Tracking (shipment ID), to AMZ (inbound delivery cost), Home/Prep (prep cost), etc. " +
  "Short dates like 4/2/2026 are read as day/month/year when both parts are ≤12 (UK-style). " +
  "Excel: if row 1 is a title, we look at the next rows to find the real column headers and map them automatically. " +
  "Product, Notes, Final, Min relsale $ are not imported unless you map them to a supported field. " +
  "Each row creates one ledger entry; ASIN/SKU must already exist in SellerBunker.";

function normHeader(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^\ufeff/, "")
    .replace(/\s+/g, " ");
}

export function guessMapping(headers: string[]): Partial<Record<CogsBulkField, string>> {
  const headerNorms = headers.map((raw) => ({
    raw,
    n: normHeader(raw),
    compact: normHeader(raw).replace(/\s/g, ""),
  }));
  const out: Partial<Record<CogsBulkField, string>> = {};
  for (const f of COGS_BULK_FIELD_META) {
    for (const alias of f.aliases) {
      const an = normHeader(alias);
      const ac = an.replace(/\s/g, "");
      const hit = headerNorms.find(
        (x) => x.n === an || x.compact === ac,
      );
      if (hit) {
        out[f.id] = hit.raw;
        break;
      }
    }
  }

  // Fuzzy fallbacks when the sheet uses slightly different wording
  if (!out.asin) {
    const h = headerNorms.find(
      (x) =>
        /\basin\b/i.test(x.n) ||
        x.compact === "asin1" ||
        x.n === "asin",
    );
    if (h) out.asin = h.raw;
  }
  if (!out.unitCostIncVat) {
    const h = headerNorms.find((x) => {
      const { n, compact } = x;
      if (/(£|€|\$)/.test(n) && /unit/.test(n)) return true;
      if (/\/\s*unit\b/i.test(n) || /£\s*\/\s*unit/i.test(n)) return true;
      if (/\bunit\b/i.test(n) && /\b(cost|cogs|price)\b/i.test(n)) return true;
      if (compact === "cost" || n === "cost") return true;
      return false;
    });
    if (h) out.unitCostIncVat = h.raw;
  }
  if (!out.orderNumber) {
    const h = headerNorms.find(
      (x) =>
        /\border\b/i.test(x.n) &&
        /\b(num|no|number|#)\b/i.test(x.n),
    );
    if (h) out.orderNumber = h.raw;
  }
  if (!out.qtyPurchased) {
    const h = headerNorms.find(
      (x) =>
        x.n === "units" ||
        (/\bunits?\b/i.test(x.n) &&
          !/delivered/i.test(x.n) &&
          !/£/.test(x.n)),
    );
    if (h) out.qtyPurchased = h.raw;
  }

  return out;
}

/** Score a candidate header row (array of cell strings) for picking the real header line in Excel. */
function scoreHeaderRowCells(cells: string[]): number {
  const nonEmpty = cells.filter((c) => c.trim().length > 0);
  if (nonEmpty.length < 2) return -1;
  const syntheticHeaders = cells.map((c, i) => {
    const t = c.trim();
    return t.length > 0 ? c.trim() : `Column ${i + 1}`;
  });
  const g = guessMapping(syntheticHeaders);
  let s = 0;
  if (g.asin) s += 100;
  if (g.sku) s += 40;
  if (g.unitCostIncVat) s += 100;
  if (g.purchaseDate) s += 15;
  if (g.qtyPurchased) s += 10;
  if (g.qtyDelivered) s += 10;
  if (g.supplier) s += 5;
  if (g.orderNumber) s += 5;
  if (g.shipmentId) s += 3;
  s += Math.min(nonEmpty.length, 20);
  return s;
}

function parseExcelSheet(
  sheet: object,
  XLSX: typeof import("xlsx"),
): { headers: string[]; rows: Record<string, unknown>[] } {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  }) as unknown[][];

  if (!aoa || aoa.length === 0) {
    return { headers: [], rows: [] };
  }

  const cellStr = (c: unknown) => String(c ?? "").trim();

  let bestIdx = 0;
  let bestScore = -Infinity;
  const scan = Math.min(25, aoa.length);
  for (let i = 0; i < scan; i++) {
    const row = aoa[i] ?? [];
    const cells = row.map(cellStr);
    const sc = scoreHeaderRowCells(cells);
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }

  const headerCells = (aoa[bestIdx] ?? []).map(cellStr);
  const maxCols = Math.max(
    headerCells.length,
    ...aoa.slice(bestIdx + 1).map((r) => (r ?? []).length),
  );

  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let c = 0; c < maxCols; c++) {
    const raw = headerCells[c]?.trim() ?? "";
    let name = raw.length > 0 ? raw : `Column ${c + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    headers.push(name);
  }

  const rows: Record<string, unknown>[] = [];
  for (let r = bestIdx + 1; r < aoa.length; r++) {
    const line = aoa[r] ?? [];
    const obj: Record<string, unknown> = {};
    let any = false;
    for (let c = 0; c < headers.length; c++) {
      const v = line[c];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        any = true;
      }
      obj[headers[c]] = v ?? "";
    }
    if (any) rows.push(obj);
  }

  return { headers, rows };
}

/** Pick the worksheet + header row that best matches a COGS purchase table. */
function scoreParsedSheet(parsed: {
  headers: string[];
  rows: Record<string, unknown>[];
}): number {
  const { headers, rows } = parsed;
  if (headers.length < 2) return -1e9;
  const g = guessMapping(headers);
  let s = 0;
  if (g.asin) s += 1000;
  if (g.unitCostIncVat) s += 1000;
  if (g.purchaseDate) s += 40;
  if (g.qtyPurchased) s += 20;
  if (g.qtyDelivered) s += 20;
  if (g.supplier) s += 10;
  if (g.orderNumber) s += 10;
  s += Math.min(rows.length, 500);
  const bad = headers.filter((h) => {
    const t = String(h).trim();
    return /^__EMPTY/i.test(t) || /^Column \d+$/i.test(t);
  }).length;
  s -= bad * 10;
  if (!g.asin || !g.unitCostIncVat) {
    s -= 2500;
  }
  return s;
}

function parseExcelWorkbook(
  wb: import("xlsx").WorkBook,
  XLSX: typeof import("xlsx"),
): { headers: string[]; rows: Record<string, unknown>[]; sheetName: string } {
  let best: {
    headers: string[];
    rows: Record<string, unknown>[];
    sheetName: string;
    score: number;
  } = {
    headers: [],
    rows: [],
    sheetName: wb.SheetNames[0] ?? "",
    score: -Infinity,
  };

  for (const sheetName of wb.SheetNames) {
    const sh = wb.Sheets[sheetName];
    if (!sh || !sh["!ref"]) continue;
    const parsed = parseExcelSheet(sh, XLSX);
    const score = scoreParsedSheet(parsed);
    if (score > best.score) {
      best = {
        headers: parsed.headers,
        rows: parsed.rows,
        sheetName,
        score,
      };
    }
  }

  if (best.headers.length === 0 && wb.SheetNames.length > 0) {
    const sh = wb.Sheets[wb.SheetNames[0]];
    if (sh) {
      const parsed = parseExcelSheet(sh, XLSX);
      return {
        headers: parsed.headers,
        rows: parsed.rows,
        sheetName: wb.SheetNames[0],
      };
    }
  }

  return {
    headers: best.headers,
    rows: best.rows,
    sheetName: best.sheetName,
  };
}

function detectDelim(line: string): "\t" | "," {
  const tabs = (line.match(/\t/g) ?? []).length;
  const commas = (line.match(/,/g) ?? []).length;
  return tabs >= commas ? "\t" : ",";
}

function splitLine(line: string, delim: "\t" | ","): string[] {
  if (delim === "\t") {
    return line.split("\t").map((c) => c.trim());
  }
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

export function parseDelimitedText(text: string): {
  headers: string[];
  rows: Record<string, unknown>[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }
  const delim = detectDelim(lines[0]);
  const headers = splitLine(lines[0], delim).map((h) =>
    h.replace(/^\ufeff/, ""),
  );
  const rows: Record<string, unknown>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const row: Record<string, unknown> = {};
    headers.forEach((h, j) => {
      row[h] = cells[j] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

export async function parseCogsUploadFile(file: File): Promise<{
  headers: string[];
  rows: Record<string, unknown>[];
  /** Set for .xlsx — which tab was used (first sheet is often a “To do” page). */
  sheetName?: string;
}> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const buf = await file.arrayBuffer();
    const XLSX = await import("xlsx");
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    const { headers, rows, sheetName } = parseExcelWorkbook(wb, XLSX);
    return { headers, rows, sheetName };
  }
  const text = await file.text();
  return parseDelimitedText(text);
}

export function buildBulkApiRows(
  rawRows: Record<string, unknown>[],
  mapping: Partial<Record<CogsBulkField, string>>,
): Record<string, unknown>[] {
  const pick = (row: Record<string, unknown>, f: CogsBulkField) => {
    const h = mapping[f];
    if (!h) return undefined;
    const v = row[h];
    if (v === undefined || v === null || v === "") return undefined;
    return v;
  };

  const out: Record<string, unknown>[] = [];
  for (const row of rawRows) {
    const asin = pick(row, "asin");
    const sku = pick(row, "sku");
    if (asin === undefined && sku === undefined) continue;
    const o: Record<string, unknown> = {};
    if (asin !== undefined) o.asin = asin;
    if (sku !== undefined) o.sku = sku;
    const cost = pick(row, "unitCostIncVat");
    if (cost !== undefined) o.unitCostIncVat = cost;
    const pd = pick(row, "purchaseDate");
    if (pd !== undefined) o.purchaseDate = pd;
    const supplier = pick(row, "supplier");
    if (supplier !== undefined) o.supplier = supplier;
    const supplierLink = pick(row, "supplierLink");
    if (supplierLink !== undefined) o.supplierLink = supplierLink;
    const shipmentId = pick(row, "shipmentId");
    if (shipmentId !== undefined) o.shipmentId = shipmentId;
    const qtyPurchased = pick(row, "qtyPurchased");
    if (qtyPurchased !== undefined) o.qtyPurchased = qtyPurchased;
    const qtyDelivered = pick(row, "qtyDelivered");
    if (qtyDelivered !== undefined) o.qtyDelivered = qtyDelivered;
    const currency = pick(row, "currency");
    if (currency !== undefined) o.currency = currency;
    const vatRatePct = pick(row, "vatRatePct");
    if (vatRatePct !== undefined) o.vatRatePct = vatRatePct;
    const deliveryCostIncVat = pick(row, "deliveryCostIncVat");
    if (deliveryCostIncVat !== undefined) {
      o.deliveryCostIncVat = deliveryCostIncVat;
    }
    const prepCostIncVat = pick(row, "prepCostIncVat");
    if (prepCostIncVat !== undefined) o.prepCostIncVat = prepCostIncVat;
    const fulfilment = pick(row, "fulfilment");
    if (fulfilment !== undefined) o.fulfilment = fulfilment;
    const bundleSize = pick(row, "bundleSize");
    if (bundleSize !== undefined) o.bundleSize = bundleSize;
    const orderNumber = pick(row, "orderNumber");
    if (orderNumber !== undefined) o.orderNumber = orderNumber;
    out.push(o);
  }
  return out;
}

export function emptyMapping(): Record<CogsBulkField, string> {
  const m = {} as Record<CogsBulkField, string>;
  for (const f of COGS_BULK_FIELD_META) {
    m[f.id] = "";
  }
  return m;
}
