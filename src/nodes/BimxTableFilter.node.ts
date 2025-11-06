// src/nodes/BimxTableFilter.node.ts
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
// exceljs als CommonJS (kompatibel mit n8n)
const ExcelJS = require('exceljs');

type Logic = 'AND' | 'OR';
type Op = 'eq'|'neq'|'contains'|'notContains'|'gt'|'gte'|'lt'|'lte'|'regex';
interface FilterRule { field: string; op: Op; value: any; }

const asNum = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
};

function compileRules(rules: FilterRule[]) {
  return rules.map(r => r.op === 'regex'
    ? { ...r, _re: (() => {
        const m = String(r.value).match(/^\/(.*)\/([gimsuy]*)$/);
        const [pat, flags] = m ? [m[1], m[2]] : [String(r.value), 'i'];
        return new RegExp(pat, flags);
      })() }
    : r
  ) as (FilterRule & { _re?: RegExp })[];
}

function rowMatches(row: Record<string, any>, rules: (FilterRule & { _re?: RegExp })[], logic: Logic): boolean {
  const evalRule = (r: FilterRule & { _re?: RegExp }) => {
    const v = row[r.field];
    switch (r.op) {
      case 'eq':  return String(v) === String(r.value);
      case 'neq': return String(v) !== String(r.value);
      case 'contains':     return String(v ?? '').includes(String(r.value ?? ''));
      case 'notContains':  return !String(v ?? '').includes(String(r.value ?? ''));
      case 'gt':  { const a = asNum(v), b = asNum(r.value); return a!==undefined && b!==undefined && a> b; }
      case 'gte': { const a = asNum(v), b = asNum(r.value); return a!==undefined && b!==undefined && a>=b; }
      case 'lt':  { const a = asNum(v), b = asNum(r.value); return a!==undefined && b!==undefined && a< b; }
      case 'lte': { const a = asNum(v), b = asNum(r.value); return a!==undefined && b!==undefined && a<=b; }
      case 'regex': return r._re!.test(String(v ?? ''));
      default: return false;
    }
  };
  if (rules.length === 0) return true;
  if (logic === 'AND') return rules.every(evalRule);
  return rules.some(evalRule);
}

/**
 * Filtert ein XLSX (Buffer) chunked und schreibt ein neues XLSX als Stream.
 * - sehr niedriger RAM-Peak
 * - gibt Pfad und Metadaten zurück
 */
export async function filterExcelToXlsxStream(
  xlsxBuffer: Buffer,
  sheetNameOrIndex: string | number | undefined,
  rules: FilterRule[],
  logic: Logic = 'AND',
  wantedColumns?: string[],   // optional: nur diese Spalten in Output
  chunkSize = 5000
): Promise<{ xlsxPath: string; outRows: number; headers: string[] }> {
  const wbIn = XLSX.read(xlsxBuffer, { type: 'buffer' });

  const sheetName = typeof sheetNameOrIndex === 'number'
    ? (wbIn.SheetNames[sheetNameOrIndex] ?? wbIn.SheetNames[0])
    : (sheetNameOrIndex || wbIn.SheetNames[0]);

  const wsIn = wbIn.Sheets[sheetName];
  if (!wsIn) throw new Error(`Sheet "${sheetName}" nicht gefunden.`);

  const ref = wsIn['!ref'] || XLSX.utils.encode_range(wsIn['!range'] as any ?? { s:{r:0,c:0}, e:{r:0,c:0} });
  const range = XLSX.utils.decode_range(ref);

  const headerRow = XLSX.utils.sheet_to_json(wsIn, {
    header: 1,
    range: { s:{ r: range.s.r, c: range.s.c }, e:{ r: range.s.r, c: range.e.c } },
    raw: true
  }) as any[][];
  const allHeaders = (headerRow[0] ?? []).map(String);
  const headers = (wantedColumns && wantedColumns.length)
    ? allHeaders.filter(h => wantedColumns.includes(h))
    : allHeaders;

  const compiled = compileRules(rules);

  // Streaming-Writer (sehr wenig Speicher)
  const outPath = path.join(os.tmpdir(), `bimx-filter-${Date.now()}.xlsx`);
  const wbOut = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outPath,
    useStyles: false,
    useSharedStrings: false, // spart RAM (Datei kann minimal größer sein)
  });
  const wsOut = wbOut.addWorksheet(sheetName || 'Filtered');

  // Header schreiben
  wsOut.addRow(headers).commit();

  let outRows = 0;
  let start = range.s.r + 1; // Daten ab Zeile 2
  const last = range.e.r;

  while (start <= last) {
    const end = Math.min(start + chunkSize - 1, last);

    const block = XLSX.utils.sheet_to_json<Record<string, any>>(wsIn, {
      header: allHeaders,
      range: { s: { r: start, c: range.s.c }, e: { r: end, c: range.e.c } },
      raw: true,
      defval: '',
      blankrows: false,
    });

    for (const row of block) {
      if (!row || Object.keys(row).length === 0) continue;
      if (rowMatches(row, compiled, logic)) {
        const out = headers.map(h => row[h] ?? '');
        wsOut.addRow(out).commit();
        outRows++;
      }
    }

    start = end + 1;
    (global as any).gc?.(); // optional
  }

  await wbOut.commit();
  return { xlsxPath: outPath, outRows, headers };
}
