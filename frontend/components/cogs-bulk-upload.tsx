"use client";

import { useCallback, useRef, useState } from "react";
import {
  COGS_BULK_FIELD_META,
  COGS_BULK_INFO,
  buildBulkApiRows,
  emptyMapping,
  guessMapping,
  parseCogsUploadFile,
  type CogsBulkField,
} from "@/lib/cogs-bulk-upload-parse";

type BulkResult = {
  created: number;
  errors: Array<{ rowIndex: number; asin?: string; message: string }>;
};

type Props = {
  onUpload: (rows: Record<string, unknown>[]) => Promise<BulkResult>;
  onFinished: () => void;
};

export function CogsBulkUpload({ onUpload, onFinished }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Record<string, unknown>[]>([]);
  const [mapping, setMapping] = useState<Record<CogsBulkField, string>>(
    emptyMapping,
  );
  const [result, setResult] = useState<BulkResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [sourceSheet, setSourceSheet] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const resetFileState = useCallback(() => {
    setFileLabel(null);
    setHeaders([]);
    setRawRows([]);
    setMapping(emptyMapping());
    setResult(null);
    setLocalError(null);
    setSourceSheet(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const handleFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setParseBusy(true);
    setLocalError(null);
    setResult(null);
    try {
      const { headers: h, rows, sheetName } = await parseCogsUploadFile(file);
      if (h.length === 0 || rows.length === 0) {
        throw new Error("No data rows found (check headers and delimiter).");
      }
      setHeaders(h);
      setRawRows(rows);
      setFileLabel(file.name);
      setSourceSheet(sheetName ?? null);
      const guessed = guessMapping(h);
      setMapping(() => {
        const next = emptyMapping();
        for (const f of COGS_BULK_FIELD_META) {
          next[f.id] = guessed[f.id] ?? "";
        }
        return next;
      });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Could not read file.");
      resetFileState();
    } finally {
      setParseBusy(false);
    }
  }, [resetFileState]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files?.[0];
      if (f) void handleFile(f);
    },
    [handleFile],
  );

  const submit = async () => {
    setLocalError(null);
    setResult(null);
    if (!(mapping.asin || mapping.sku) || !mapping.unitCostIncVat) {
      setLocalError(
        'Map "Unit cost (inc VAT)" and at least one of "ASIN" or "SKU" to columns.',
      );
      return;
    }
    const payload = buildBulkApiRows(rawRows, mapping);
    if (payload.length === 0) {
      setLocalError("No data rows with an ASIN or SKU in the mapped columns.");
      return;
    }
    setBusy(true);
    try {
      const r = await onUpload(payload);
      setResult(r);
      if (r.created > 0) {
        await onFinished();
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (busy || parseBusy) return;
    setOpen(false);
    resetFileState();
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setResult(null);
            setLocalError(null);
          }}
          className="cursor-pointer rounded-lg border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5"
        >
          Automatic COGS upload
        </button>
        <span
          className="inline-flex h-6 w-6 cursor-help items-center justify-center rounded-full border border-[var(--surface-border)] text-xs font-semibold text-[var(--muted-foreground)]"
          title={COGS_BULK_INFO}
          aria-label="File format and column requirements"
        >
          i
        </span>
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cogs-bulk-title"
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--surface-border)] bg-[var(--surface)] p-5 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-2">
              <div>
                <h2
                  id="cogs-bulk-title"
                  className="text-lg font-semibold text-[var(--foreground)]"
                >
                  Automatic COGS upload
                </h2>
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Match spreadsheet columns to fields. Hover the “i” on the
                  Cost of Goods page for full format notes.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                className="shrink-0 rounded-lg px-2 py-1 text-sm text-[var(--muted-foreground)] hover:bg-[var(--foreground)]/5"
              >
                ✕
              </button>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
            />

            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onDrop={onDrop}
              className="mb-4 rounded-lg border-2 border-dashed border-[var(--surface-border)] bg-[var(--background)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]"
            >
              {parseBusy ? (
                "Reading file…"
              ) : fileLabel ? (
                <span className="block text-[var(--foreground)]">
                  {fileLabel}
                  {sourceSheet ? (
                    <span className="mt-1 block text-xs font-normal text-[var(--muted-foreground)]">
                      Using worksheet: &quot;{sourceSheet}&quot; (we skip tabs like
                      &quot;TO DO LIST&quot; and pick the sheet that has ASIN + unit
                      cost columns.)
                    </span>
                  ) : null}
                </span>
              ) : (
                <>
                  Drag and drop an Excel or TSV/CSV file here, or{" "}
                  <button
                    type="button"
                    className="font-medium text-sb-accent underline"
                    onClick={() => inputRef.current?.click()}
                  >
                    browse
                  </button>
                </>
              )}
            </div>

            {fileLabel ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="mb-4 text-xs text-sb-accent underline"
              >
                Choose a different file
              </button>
            ) : null}

            {headers.length > 0 ? (
              <div className="mb-4 space-y-2">
                <p className="text-xs font-medium text-[var(--foreground)]">
                  Column mapping
                </p>
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
                  Your file uses its own header names (e.g. &quot;£/Unit&quot;). For each
                  SellerBunker field below, choose which <strong>column from your file</strong>{" "}
                  supplies that value. Required: unit cost, plus ASIN and/or SKU per row. Leave others as — if empty.
                </p>
                <div className="grid max-h-56 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {COGS_BULK_FIELD_META.map((f) => (
                    <label
                      key={f.id}
                      className="flex flex-col gap-0.5 text-xs text-[var(--muted-foreground)]"
                    >
                      <span>
                        {f.label}
                        {f.required ? (
                          <span className="text-red-500"> *</span>
                        ) : null}
                      </span>
                      <select
                        value={mapping[f.id]}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [f.id]: e.target.value,
                          }))
                        }
                        className="rounded border border-[var(--surface-border)] bg-[var(--background)] px-2 py-1.5 text-sm text-[var(--foreground)]"
                      >
                        <option value="">—</option>
                        {headers.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Preview: {Math.min(3, rawRows.length)} of {rawRows.length}{" "}
                  rows
                </p>
                <div className="overflow-x-auto rounded border border-[var(--surface-border)] text-xs">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b border-[var(--surface-border)] bg-[var(--background)]">
                        {headers.slice(0, 8).map((h) => (
                          <th key={h} className="p-2 font-medium">
                            {h}
                          </th>
                        ))}
                        {headers.length > 8 ? (
                          <th className="p-2">…</th>
                        ) : null}
                      </tr>
                    </thead>
                    <tbody>
                      {rawRows.slice(0, 3).map((row, i) => (
                        <tr
                          key={i}
                          className="border-b border-[var(--surface-border)]"
                        >
                          {headers.slice(0, 8).map((h) => (
                            <td key={h} className="p-2 text-[var(--foreground)]">
                              {String(row[h] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {localError ? (
              <p className="mb-3 text-sm text-red-600">{localError}</p>
            ) : null}

            {result ? (
              <div className="mb-4 rounded-lg border border-[var(--surface-border)] bg-[var(--background)] p-3 text-sm text-[var(--foreground)]">
                <p>
                  Created <strong>{result.created}</strong> entr
                  {result.created === 1 ? "y" : "ies"}.
                </p>
                {result.errors.length > 0 ? (
                  <div className="mt-2 max-h-40 overflow-y-auto text-xs text-red-600">
                    <p className="font-medium text-[var(--foreground)]">
                      {result.errors.length} row(s) skipped:
                    </p>
                    <ul className="list-inside list-disc">
                      {result.errors.slice(0, 25).map((err, i) => (
                        <li key={i}>
                          Row {err.rowIndex}
                          {err.asin ? ` (${err.asin})` : ""}: {err.message}
                        </li>
                      ))}
                    </ul>
                    {result.errors.length > 25 ? (
                      <p className="mt-1">…and more</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={
                  busy ||
                  parseBusy ||
                  headers.length === 0 ||
                  !mapping.asin ||
                  !mapping.unitCostIncVat
                }
                onClick={() => void submit()}
                className="cursor-pointer rounded-lg bg-sb-accent px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
              >
                {busy ? "Uploading…" : "Upload to COGS"}
              </button>
              <button
                type="button"
                disabled={busy || parseBusy}
                onClick={close}
                className="cursor-pointer rounded-lg border border-[var(--surface-border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--foreground)]/5 disabled:opacity-50"
              >
                {result && result.created > 0 ? "Done" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
