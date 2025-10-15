// src/nodes/BimxRuleValidator.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import ExcelJS from 'exceljs';
import { Buffer as NodeBuffer } from 'buffer';

/* -------------------------------------------------------------------------- */
/* Typen                                                                      */
/* -------------------------------------------------------------------------- */

type Operator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'empty'
  | 'notEmpty'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'eq'
  | 'neq';

type ColorName = 'red' | 'yellow' | 'none';

interface Rule {
  title?: string;
  field: string;        // JSON-Path, z. B. "Space.Name" oder "Pset_SpaceCommon.Reference"
  op: Operator;
  value?: string;
  color?: ColorName;
  ifcType?: string;     // "IFCSPACE,IFCDOOR"
}

interface RuleHit {
  ruleIndex: number;
  ruleTitle: string;
  rowIndex: number;
  guid?: string;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function toNumber(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function matchRule(rule: Rule, row: Record<string, any>): boolean {
  // optional IFC-Type-Filter
  if (rule.ifcType) {
    const allowed = rule.ifcType
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const typeCand =
      (row['IFCType'] ?? row['type'] ?? row['ObjectType'] ?? row['Type']) ?? '';
    const got = String(typeCand).toUpperCase();
    if (allowed.length > 0 && !allowed.includes(got)) return false;
  }

  const raw = getByPath(row, rule.field);
  const val = raw == null ? '' : String(raw);

  switch (rule.op) {
    case 'is':
    case 'eq':
      return val === (rule.value ?? '');
    case 'isNot':
    case 'neq':
      return val !== (rule.value ?? '');
    case 'contains':
      return val.includes(rule.value ?? '');
    case 'notContains':
      return !val.includes(rule.value ?? '');
    case 'regex': {
      try {
        const rx = new RegExp(rule.value ?? '', 'i');
        return rx.test(val);
      } catch {
        return false;
      }
    }
    case 'empty':
      return val === '' || val === 'null' || val === 'undefined';
    case 'notEmpty':
      return !(val === '' || val === 'null' || val === 'undefined');
    case 'lt': {
      const a = toNumber(val);
      const b = toNumber(rule.value);
      return a != null && b != null && a < b;
    }
    case 'lte': {
      const a = toNumber(val);
      const b = toNumber(rule.value);
      return a != null && b != null && a <= b;
    }
    case 'gt': {
      const a = toNumber(val);
      const b = toNumber(rule.value);
      return a != null && b != null && a > b;
    }
    case 'gte': {
      const a = toNumber(val);
      const b = toNumber(rule.value);
      return a != null && b != null && a >= b;
    }
  }
}

function unionHeaders(rows: Array<Record<string, any>>): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) set.add(k);
  }
  const out: string[] = [];
  set.forEach((k) => out.push(k));
  return out;
}

function toCsv(rows: Array<Record<string, any>>): string {
  if (!rows.length) return '';
  const headers = unionHeaders(rows);
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [];
  lines.push(headers.join(','));
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\n');
}

const FILL_RED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } }; // light red
const FILL_YEL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } }; // light yellow

// Robust: konvertiert ExcelJS writeBuffer() Resultate verlässlich in Node-Buffer
function toNodeBuffer(raw: unknown): NodeBuffer {
  if (NodeBuffer.isBuffer(raw)) return raw as NodeBuffer;
  if (raw instanceof ArrayBuffer) return NodeBuffer.from(new Uint8Array(raw));
  if (ArrayBuffer.isView(raw)) return NodeBuffer.from((raw as ArrayBufferView).buffer);
  // Fallback
  return NodeBuffer.from(String(raw ?? ''), 'binary');
}

/* -------------------------------------------------------------------------- */
/* Node                                                                        */
/* -------------------------------------------------------------------------- */

export class BimxRuleValidator implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Rule Validator',
    name: 'bimxRuleValidator',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description:
      'Validate table rows (JSON/XLSX) against multiple rules and generate a highlighted XLSX report + GUID lists.',
    defaults: { name: 'BIM X – Rule Validator' },
    inputs: ['main'],
    outputs: ['main', 'main'], // 0: report/meta; 1: GUID lists per rule
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'items',
        options: [
          { name: 'Items (JSON)', value: 'items' },
          { name: 'Binary XLSX', value: 'binary' },
        ],
      },
      {
        displayName: 'Binary Property',
        name: 'binaryProperty',
        type: 'string',
        default: 'xlsx',
        description: 'When Source = Binary XLSX, read from this binary property.',
        displayOptions: { show: { source: ['binary'] } },
      },

      {
        displayName: 'Rules',
        name: 'rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'rule',
            displayName: 'Rule',
            values: [
              { displayName: 'Title', name: 'title', type: 'string', default: '' },
              {
                displayName: 'Field (JSON path)',
                name: 'field',
                type: 'string',
                default: '',
                placeholder: 'e.g. Space.Name or Pset_SpaceCommon.Reference',
              },
              {
                displayName: 'Operator',
                name: 'op',
                type: 'options',
                default: 'is',
                options: [
                  { name: 'Is (equal)', value: 'is' },
                  { name: 'Is Not', value: 'isNot' },
                  { name: 'Contains', value: 'contains' },
                  { name: 'Not Contains', value: 'notContains' },
                  { name: 'Regex', value: 'regex' },
                  { name: 'Empty', value: 'empty' },
                  { name: 'Not Empty', value: 'notEmpty' },
                  { name: 'Less Than', value: 'lt' },
                  { name: 'Less or Equal', value: 'lte' },
                  { name: 'Greater Than', value: 'gt' },
                  { name: 'Greater or Equal', value: 'gte' },
                  { name: 'Equal (number)', value: 'eq' },
                  { name: 'Not Equal (number)', value: 'neq' },
                ],
              },
              {
                displayName: 'Value / Pattern',
                name: 'value',
                type: 'string',
                default: '',
              },
              {
                displayName: 'IFC Type filter (optional)',
                name: 'ifcType',
                type: 'string',
                default: '',
                description:
                  'Comma-separated list (e.g. IFCSPACE,IFCDOOR). Leave empty for all.',
              },
              {
                displayName: 'Highlight Color',
                name: 'color',
                type: 'options',
                default: 'red',
                options: [
                  { name: 'Red', value: 'red' },
                  { name: 'Yellow', value: 'yellow' },
                  { name: 'None', value: 'none' },
                ],
              },
            ],
          },
        ],
      },

      {
        displayName: 'GUID Field',
        name: 'guidField',
        type: 'string',
        default: 'GlobalId',
      },
      {
        displayName: 'Report Title',
        name: 'reportTitle',
        type: 'string',
        default: 'Validation Report',
      },
      {
        displayName: 'Generate XLSX Report',
        name: 'emitXlsx',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Generate JSON (meta & hits)',
        name: 'emitJson',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Generate CSV (GUIDs per rule)',
        name: 'emitCsv',
        type: 'boolean',
        default: false,
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    const source = this.getNodeParameter('source', 0) as 'items' | 'binary';
    const binaryProperty = this.getNodeParameter('binaryProperty', 0, 'xlsx') as string;

    const rulesColl = this.getNodeParameter('rules', 0, {}) as {
      rule?: Rule[];
    };
    const rules: Rule[] = Array.isArray(rulesColl?.rule) ? rulesColl.rule : [];

    const guidField = this.getNodeParameter('guidField', 0) as string;
    const reportTitle = this.getNodeParameter('reportTitle', 0) as string;
    const emitXlsx = this.getNodeParameter('emitXlsx', 0) as boolean;
    const emitJson = this.getNodeParameter('emitJson', 0) as boolean;
    const emitCsv = this.getNodeParameter('emitCsv', 0) as boolean;

    /* ------------------------------- Daten laden --------------------------- */
    const rows: Array<Record<string, any>> = [];

    if (source === 'items') {
      // Variante A: Vorheriger Node liefert { json: { rows: [...] } }
      if (Array.isArray(items[0]?.json?.rows)) {
        const arr = (items[0].json as any).rows as any[];
        for (const r of arr) {
          rows.push(typeof r === 'object' && r ? r : { value: r });
        }
      } else {
        // Variante B: Jedes Item = eine Zeile
        for (const it of items) rows.push({ ...(it.json || {}) });
      }
    } else {
      // Source: Binary XLSX
      const bin = items[0]?.binary?.[binaryProperty];
      if (!bin?.data) throw new Error(`Binary property "${binaryProperty}" not found.`);
      const buf = NodeBuffer.from(bin.data as string, 'base64');

      const wbIn = new ExcelJS.Workbook();
      await wbIn.xlsx.load(buf);
      const wsIn = wbIn.worksheets[0];
      if (!wsIn) throw new Error('No worksheet in XLSX.');

      const headers: string[] = [];
      const headerRow = wsIn.getRow(1);
      headerRow.eachCell((cell, col) => {
        headers[col - 1] = String(cell.value ?? `col_${col}`);
      });

      for (let r = 2; r <= wsIn.rowCount; r++) {
        const obj: Record<string, any> = {};
        for (let c = 1; c <= headers.length; c++) {
          const v: any = wsIn.getCell(r, c).value;
          obj[headers[c - 1]] =
            v && typeof v === 'object' && 'result' in (v as any)
              ? (v as any).result
              : v;
        }
        rows.push(obj);
      }
    }

    /* ---------------------------- Regeln auswerten ------------------------- */
    const hits: RuleHit[] = [];
    const guidsPerRule: Array<{
      ruleIndex: number;
      ruleTitle: string;
      count: number;
      guids: string[];
    }> = [];

    for (let i = 0; i < rules.length; i++) {
      guidsPerRule.push({
        ruleIndex: i,
        ruleTitle: rules[i].title || `Rule ${i + 1}`,
        count: 0,
        guids: [],
      });
    }

    rows.forEach((row, rowIndex) => {
      rules.forEach((rule, ruleIndex) => {
        try {
          if (matchRule(rule, row)) {
            const guid = String(row[guidField] ?? row['GUID'] ?? '');
            hits.push({
              ruleIndex,
              ruleTitle: rule.title || `Rule ${ruleIndex + 1}`,
              rowIndex,
              guid,
            });
            guidsPerRule[ruleIndex].count++;
            if (guid) guidsPerRule[ruleIndex].guids.push(guid);
          }
        } catch {
          // einzelne Zeile ignorieren
        }
      });
    });

    /* ----------------------------- Outputs bauen -------------------------- */
    const outMain: INodeExecutionData[] = [];
    const outBranch2: INodeExecutionData[] = [];

    const metaJson: any = {
      title: reportTitle,
      totalRows: rows.length,
      totalRules: rules.length,
      hits: hits.length,
      perRule: guidsPerRule.map((g) => ({
        index: g.ruleIndex,
        title: g.ruleTitle,
        count: g.count,
        guids: g.guids,
      })),
    };

    if (emitXlsx) {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'BIM X – Rule Validator';
      wb.created = new Date();

      // Data
      const ws = wb.addWorksheet('Data');
      (ws as any).views = [{ state: 'frozen', ySplit: 1 }];

      const headers = unionHeaders(rows);
      ws.columns = [
        ...headers.map((h) => ({ header: h, key: h })),
        { header: 'Violations', key: '__violations__' },
      ] as any;

      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell) => {
        (cell as any).font = { bold: true };
        (cell as any).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFE3F2FD' },
        };
      });

      // Lookup: rowIndex -> {fields, titles}
      const byRow = new Map<number, { fields: Map<string, ColorName>; titles: string[] }>();
      for (const h of hits) {
        const field = rules[h.ruleIndex]?.field ?? '';
        const col = rules[h.ruleIndex]?.color ?? 'red';
        if (!byRow.has(h.rowIndex)) byRow.set(h.rowIndex, { fields: new Map(), titles: [] });
        const rec = byRow.get(h.rowIndex)!;
        rec.fields.set(field, col);
        rec.titles.push(h.ruleTitle);
      }

      rows.forEach((r, i) => {
        const vio = byRow.get(i)?.titles.join(' | ') ?? '';
        const row = ws.addRow({ ...(r as any), __violations__: vio });
        const rec = byRow.get(i);
        if (rec) {
          headers.forEach((h) => {
            if (rec.fields.has(h)) {
              const col = rec.fields.get(h);
              const cell = row.getCell(h) as any; // key access
              if (col === 'red') cell.fill = FILL_RED as any;
              else if (col === 'yellow') cell.fill = FILL_YEL as any;
            }
          });
        }
      });

      // Spaltenbreiten
      const maxLen: Record<string, number> = {};
      const allKeys = [...headers, '__violations__'];
      for (const k of allKeys) {
        const displayHeader = k === '__violations__' ? 'Violations' : k;
        maxLen[k] = Math.max(10, displayHeader.length);
      }
      rows.forEach((r, i) => {
        for (const h of headers) {
          const v = r[h];
          const s = v == null ? '' : String(v);
          maxLen[h] = Math.min(Math.max(maxLen[h], s.length), 60);
        }
        const vio = byRow.get(i)?.titles.join(' | ') ?? '';
        maxLen['__violations__'] = Math.min(Math.max(maxLen['__violations__'], vio.length), 80);
      });
      (ws.columns || []).forEach((c: any) => {
        const key = c.key as string;
        const ml = maxLen[key] ?? 12;
        c.width = Math.max(ml + 2, 10);
      });

      // Summary
      const wsSum = wb.addWorksheet('Summary');
      const titleRow = wsSum.addRow([reportTitle]);
      titleRow.getCell(1).font = { size: 14, bold: true };
      wsSum.addRow([]);
      const hdr = wsSum.addRow(['#', 'Rule Title', 'Field', 'Operator', 'Value/Pattern', 'IFC Filter', 'Color', 'Hits']);
      hdr.eachCell((cell) => ((cell as any).font = { bold: true }));
      rules.forEach((r, idx) => {
        const rec = guidsPerRule[idx];
        wsSum.addRow([
          idx + 1,
          r.title || `Rule ${idx + 1}`,
          r.field,
          r.op,
          r.value ?? '',
          r.ifcType ?? '',
          r.color ?? 'red',
          rec.count,
        ]);
      });

      // GUIDs
      const wsGuid = wb.addWorksheet('GUIDs');
      const gHdr = wsGuid.addRow(['Rule #', 'Rule Title', 'GUID']);
      gHdr.eachCell((cell) => ((cell as any).font = { bold: true }));
      guidsPerRule.forEach((rec) => {
        for (const g of rec.guids) wsGuid.addRow([rec.ruleIndex + 1, rec.ruleTitle, g]);
      });

      // writeBuffer → Node-Buffer normalisieren
      const raw: unknown = await (wb.xlsx as any).writeBuffer(); // ArrayBuffer/Uint8Array abhängig von Umgebung
      const nodeLike: NodeBuffer = toNodeBuffer(raw);
      const nodeBuf: NodeBuffer = NodeBuffer.from(nodeLike); // garantiert NodeBuffer

      const bin = await this.helpers.prepareBinaryData(nodeBuf);
      bin.fileName = 'validation_report.xlsx';
      bin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      outMain.push({ json: metaJson, binary: { report: bin } });
    } else if (emitJson) {
      outMain.push({ json: metaJson });
    }

    if (emitJson) {
      outBranch2.push({ json: { perRule: metaJson.perRule } });
    }

    if (emitCsv) {
      for (const rec of guidsPerRule) {
        const csv = toCsv(rec.guids.map((g) => ({ rule: rec.ruleTitle, guid: g })));
        const csvBuf: NodeBuffer = NodeBuffer.from(csv, 'utf8');
        const bin = await this.helpers.prepareBinaryData(csvBuf);
        bin.fileName = `guids_${(rec.ruleTitle || `rule_${rec.ruleIndex + 1}`)}.csv`;
        bin.mimeType = 'text/csv';
        outBranch2.push({
          json: { rule: rec.ruleTitle, count: rec.count },
          binary: { csv: bin },
        });
      }
    }

    return [outMain, outBranch2];
  }
}
