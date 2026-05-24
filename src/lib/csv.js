// Minimal CSV builder + browser download trigger.

function escapeCell(value) {
  const s = value == null ? "" : String(value);
  // Wrap and double-quote whenever the cell contains a delimiter, quote, or newline.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCell(c.label)).join(",");
  const body = rows
    .map((row) => columns.map((c) => escapeCell(row[c.key])).join(","))
    .join("\r\n");
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

export function downloadCsv(filename, csv) {
  // BOM so Excel opens UTF-8 CSVs (including CJK) without mojibake.
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
