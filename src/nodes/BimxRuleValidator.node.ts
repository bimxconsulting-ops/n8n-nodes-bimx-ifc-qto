// src/nodes/BimxRuleValidator.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import ExcelJS from 'exceljs';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
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
  field: string;        // JSON-Path, z.B. "Pset_SpaceCommon.Reference"
  op: Operator;
  value?: string;       // optional (bei regex/numeric/contains/eq)
  color?: ColorName;    // Markierung im Report
  ifcType?: string;     // optionaler Filter (z.B. "IFCSPACE,IFCDOOR")
}

interface RuleHit {
  ruleIndex: number;
  ruleTitle: string;
  rowIndex: number;
  guid?: string;
}

/** Sicherer Getter per "a.b.c" */
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
  // IFC-Type-Filter (optional): prüft gegen beliebige Spalte "IFCType" | "type" | "ObjectType"
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

/** CSV Helfer */
function toCsv(rows: Array<Record<string, any>>): string {
  if (!rows.length) return '';
  const headers = Array.from(
    rows.reduce((s, r) => {
      Object.keys(r).forEach((k) => s.add(k));
      return s;
    }, new Set<string>()),
  );
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\n');
}

/** ExcelJS Fills */
const FILL_RED = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };    // light red
const FILL_YEL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF59D' } };    // light yellow

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
    description: 'Validate table rows (JSON/XLSX) against multiple rules and generate a highlighted XLSX report + GUID lists.',
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

      // Rules
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
                description: 'Comma-separated list (e.g. IFCSPACE,IFCDOOR). Leave empty for all.',
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

      // Options
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

    // ---------- Load rows ----------
    const rows: Array<Record<string, any>> = [];

    if (source === 'items') {
      // Variante A: Vorheriger Node liefert { json: { rows: [...] } }
      if (Array.isArray(items[0]?.json?.rows)) {
        for (const r of (items[0].json as any).rows as any[]) {
          rows.push(typeof r === 'object' && r ? r : { value: r });
        }
      } else {
        // Variante B: Jedes Item ist eine Zeile
        for (const it of items) rows.push({ ...(it.json || {}) });
      }
    } else {
      // Source: Binary XLSX
      const bin = items[0]?.binary?.[binaryProperty];
      if (!bin?.data) {
        throw new Error(`Binary property "${binaryProperty}" not found.`);
      }
      const buf = Buffer.from(bin.data as string, 'base64');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('No worksheet in XLSX.');

      const headers: string[] = [];
      const headerRow = ws.getRow(1);
      headerRow.eachCell((cell, col) => {
        headers[col - 1] = String(cell.value ?? `col_${col}`);
      });

      for (let r = 2; r <= ws.rowCount; r++) {
        const obj: Record<string, any> = {};
        for (let c = 1; c <= headers.length; c++) {
          const v: any = ws.getCell(r, c).value;
          obj[headers[c - 1]] = (v && typeof v === 'object' && 'result' in v) ? (v as any).result : v;
        }
        rows.push(obj);
      }
    }

    // ---------- Evaluate rules ----------
    const hits: RuleHit[] = [];
    const guidsPerRule: Array<{ ruleIndex: number; ruleTitle: string; count: number; guids: string[] }> = [];

    // Init buckets
    for (let i = 0; i < rules.length; i++) {
      guidsPerRule.push({ ruleIndex: i, ruleTitle: rules[i].title || `Rule ${i + 1}`, count: 0, guids: [] });
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
          // ignore single row error
        }
      });
    });

    // ---------- Build XLSX report ----------
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

      // Data sheet
      const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });

      // Headers (Union aller Keys)
      const headers = Array.from(
        rows.reduce((s, r) => {
          Object.keys(r).forEach((k) => s.add(k));
          return s;
        }, new Set<string>()),
      );

      // plus Violations column
      const headerRow = ws.addRow([...headers, 'Violations']);
      headerRow.font = { bold: true };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE3F2FD' } };

      // Map hits for quick lookup: rowIndex -> Set(field) & ruleTitles
      const byRow = new Map<number, { fields: Map<string, ColorName>; titles: string[] }>();
      for (const h of hits) {
        const field = rules[h.ruleIndex]?.field ?? '';
        const col = rules[h.ruleIndex]?.color ?? 'red';
        if (!byRow.has(h.rowIndex)) byRow.set(h.rowIndex, { fields: new Map(), titles: [] });
        const rec = byRow.get(h.rowIndex)!;
        rec.fields.set(field, col);
        rec.titles.push(h.ruleTitle);
      }

      // Rows
      rows.forEach((r, i) => {
        const vals = headers.map((h) => r[h]);
        const vio = byRow.get(i)?.titles.join(' | ') ?? '';
        const row = ws.addRow([...vals, vio]);

        // Coloring per rule field
        const rec = byRow.get(i);
        if (rec) {
          headers.forEach((h, idx) => {
            if (rec.fields.has(h)) {
              const col = rec.fields.get(h);
              const cell = row.getCell(idx + 1);
              if (col === 'red') cell.fill = FILL_RED as any;
              else if (col === 'yellow') cell.fill = FILL_YEL as any;
            }
          });
        }
      });

      ws.columns.forEach((c) => {
        let max = 10;
        c.eachCell({ includeEmpty: true }, (cell) => {
          const v = cell.value == null ? '' : String(cell.value);
          if (v.length > max) max = Math.min(v.length, 60);
        });
        c.width = max + 2;
      });

      // Summary sheet
      const wsSum = wb.addWorksheet('Summary');
      wsSum.addRow([reportTitle]).font = { size: 14, bold: true };
      wsSum.addRow([]);
      wsSum.addRow(['#', 'Rule Title', 'Field', 'Operator', 'Value/Pattern', 'IFC Filter', 'Color', 'Hits']).font = {
        bold: true,
      };

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

      // GUID sheet
      const wsGuid = wb.addWorksheet('GUIDs');
      wsGuid.addRow(['Rule #', 'Rule Title', 'GUID']).font = { bold: true };
      guidsPerRule.forEach((rec) => {
        for (const g of rec.guids) wsGuid.addRow([rec.ruleIndex + 1, rec.ruleTitle, g]);
      });

      const abuf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
      const nodeBuf = Buffer.from(new Uint8Array(abuf));
      const bin = await this.helpers.prepareBinaryData(nodeBuf);
      bin.fileName = 'validation_report.xlsx';
      bin.mimeType =
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      outMain.push({ json: metaJson, binary: { report: bin } });
    } else if (emitJson) {
      outMain.push({ json: metaJson });
    }

    if (emitJson) {
      outBranch2.push({ json: { perRule: metaJson.perRule } });
    }

    if (emitCsv) {
      // one CSV per rule, concatenated as multiple items
      for (const rec of guidsPerRule) {
        const csv = toCsv(rec.guids.map((g) => ({ rule: rec.ruleTitle, guid: g })));
        const bin = await this.helpers.prepareBinaryData(Buffer.from(csv, 'utf8'));
        bin.fileName = `guids_${(rec.ruleTitle || `rule_${rec.ruleIndex + 1}`)}.csv`;
        bin.mimeType = 'text/csv';
        outBranch2.push({ json: { rule: rec.ruleTitle, count: rec.count }, binary: { csv: bin } });
      }
    }

    return [outMain, outBranch2];
  }
}
