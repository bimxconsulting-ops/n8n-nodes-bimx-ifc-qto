// src/nodes/BimxRuleValidator.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

// exceljs als CommonJS laden (kompatibel ohne esModuleInterop)
const ExcelJS = require('exceljs');

type Operator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'regex'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'notEmpty'
  | 'isNumber'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isUnique';

type RuleParam = {
  title: string;
  field: string;              // JSON-Pfad oder Spaltenname
  operator: Operator;
  pattern?: string;           // Vergleichswert/Regex
  ifcFilterCsv?: string;      // z.B. "IFCSPACE,IFCWALL"
  color?: string;             // z.B. "red", "#ff0000", "255,0,0"
};

type Hit = { rowIndex: number; guid?: string };

function getByPath(obj: any, path: string): any {
  if (!path) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: any = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as any)[p];
  }
  return cur;
}

function toStringSafe(v: any): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function testOperator(value: any, op: Operator, pattern?: string): boolean {
  const v = value;
  const s = toStringSafe(v);

  switch (op) {
    case 'equals':        return s === (pattern ?? '');
    case 'notEquals':     return s !== (pattern ?? '');
    case 'contains':      return s.includes(pattern ?? '');
    case 'notContains':   return !s.includes(pattern ?? '');
    case 'startsWith':    return s.startsWith(pattern ?? '');
    case 'endsWith':      return s.endsWith(pattern ?? '');
    case 'isEmpty':       return s === '' || v == null;
    case 'notEmpty':      return !(s === '' || v == null);
    case 'isNumber':      return !isNaN(Number(v));
    case 'regex': {
      if (!pattern) return false;
      try {
        const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
        const rx = m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
        return rx.test(s);
      } catch { return false; }
    }
    case 'gt':  return Number(v) >  Number(pattern);
    case 'gte': return Number(v) >= Number(pattern);
    case 'lt':  return Number(v) <  Number(pattern);
    case 'lte': return Number(v) <= Number(pattern);
    case 'isUnique': // wird separat berechnet – hier immer false
      return false;
    default:
      return false;
  }
}

function slug(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function colorNameToArgb(color?: string): string {
  if (!color) return 'FFFFC7CE'; // soft red
  const map: Record<string, string> = {
    red: 'FFFFC7CE',
    yellow: 'FFFFF4CC',
    orange: 'FFFFE0B2',
    green: 'FFC6EFCE',
    blue: 'FFDBEAFE',
    purple: 'FFE9D5FF',
  };
  const lower = color.toLowerCase();
  if (map[lower]) return map[lower];

  // CSV "r,g,b"
  const mCsv = color.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
  if (mCsv) {
    const r = (+mCsv[1]).toString(16).padStart(2, '0').toUpperCase();
    const g = (+mCsv[2]).toString(16).padStart(2, '0').toUpperCase();
    const b = (+mCsv[3]).toString(16).padStart(2, '0').toUpperCase();
    return `FF${r}${g}${b}`;
  }

  // Hex "#rrggbb"
  const hex = color.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return `FF${hex.toUpperCase()}`;
  }

  return 'FFFFC7CE';
}

export class BimxRuleValidator implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Rule Validator',
    name: 'bimxRuleValidator',
    group: ['transform'],
    version: 1,
    icon: 'file:BIMX.svg',
    description: 'Validiert Tabellen (XLSX/JSON) anhand von Regeln und erzeugt Report/Metadaten',
    defaults: { name: 'BIM X – Rule Validator' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'xlsx',
        options: [
          { name: 'Binary XLSX', value: 'xlsx' },
          { name: 'Previous node JSON', value: 'json' },
        ],
      },
      {
        displayName: 'Binary Property',
        name: 'binaryProperty',
        type: 'string',
        default: 'xlsx',
        displayOptions: { show: { source: ['xlsx'] } },
      },

      // Regeln
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
              { displayName: 'Field (JSON path)', name: 'field', type: 'string', default: '' },
              {
                displayName: 'Operator',
                name: 'operator',
                type: 'options',
                default: 'contains',
                options: [
                  { name: 'Contains', value: 'contains' },
                  { name: 'Not Contains', value: 'notContains' },
                  { name: 'Equals', value: 'equals' },
                  { name: 'Not Equals', value: 'notEquals' },
                  { name: 'Starts With', value: 'startsWith' },
                  { name: 'Ends With', value: 'endsWith' },
                  { name: 'Regex', value: 'regex' },
                  { name: 'Is Empty', value: 'isEmpty' },
                  { name: 'Not Empty', value: 'notEmpty' },
                  { name: 'Is Number', value: 'isNumber' },
                  { name: 'Greater Than', value: 'gt' },
                  { name: 'Greater Or Equal', value: 'gte' },
                  { name: 'Less Than', value: 'lt' },
                  { name: 'Less Or Equal', value: 'lte' },
                  { name: 'Is Unique (flag duplicates)', value: 'isUnique' },
                ],
              },
              { displayName: 'Value / Pattern', name: 'pattern', type: 'string', default: '' },
              {
                displayName: 'IFC Type filter (CSV)',
                name: 'ifcFilterCsv',
                type: 'string',
                default: '',
                description: 'Nur diese IFC-Typen prüfen, z.B. IFCSPACE,IFCWALL (optional).',
              },
              {
                displayName: 'Highlight Color',
                name: 'color',
                type: 'options',
                default: 'red',
                options: [
                  { name: 'Red', value: 'red' },
                  { name: 'Yellow', value: 'yellow' },
                  { name: 'Orange', value: 'orange' },
                  { name: 'Green', value: 'green' },
                  { name: 'Blue', value: 'blue' },
                  { name: 'Purple', value: 'purple' },
                ],
              },
            ],
          },
        ],
      },

      { displayName: 'GUID Field', name: 'guidField', type: 'string', default: 'GlobalId' },
      { displayName: 'Report Title', name: 'reportTitle', type: 'string', default: 'Validation Report' },

      { displayName: 'Generate XLSX Report', name: 'genXlsx', type: 'boolean', default: true },
      { displayName: 'Generate JSON Meta',  name: 'genJson', type: 'boolean', default: true },
      { displayName: 'Generate CSV (per Rule GUIDs)', name: 'genCsv', type: 'boolean', default: false },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    if (!items.length) return [items];

    const source       = this.getNodeParameter('source', 0) as 'xlsx'|'json';
    const binProp      = this.getNodeParameter('binaryProperty', 0, 'xlsx') as string;
    const rulesParam   = (this.getNodeParameter('rules', 0, {}) as any)?.rule as RuleParam[] | undefined;
    const guidField    = this.getNodeParameter('guidField', 0) as string;
    const reportTitle  = this.getNodeParameter('reportTitle', 0) as string;
    const genXlsx      = this.getNodeParameter('genXlsx', 0) as boolean;
    const genJson      = this.getNodeParameter('genJson', 0) as boolean;
    const genCsv       = this.getNodeParameter('genCsv', 0) as boolean;

    const rules: RuleParam[] = Array.isArray(rulesParam) ? rulesParam : [];
    if (!rules.length) {
      throw new NodeOperationError(this.getNode(), 'No rules defined.');
    }

    // -------- Datenquelle laden -> rows (Array of objects), headers (string[])
    let rows: Record<string, any>[] = [];
    let headers: string[] = [];

    if (source === 'xlsx') {
      const bin = items[0].binary?.[binProp];
      if (!bin?.data) throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" not found`);

      const buf = Buffer.from(bin.data as string, 'base64');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf);
      const ws = wb.worksheets[0];
      if (!ws) throw new NodeOperationError(this.getNode(), 'No worksheet found in XLSX.');

      // Header aus erster Zeile
      headers = [];
      ws.getRow(1).eachCell((cell: any, col: number) => {
        headers[col - 1] = toStringSafe(cell.value);
      });

      // Datenzeilen
      rows = [];
      ws.eachRow((row: any, idx: number) => {
        if (idx === 1) return;
        const obj: Record<string, any> = {};
        row.eachCell((cell: any, col: number) => {
          const key = headers[col - 1] ?? `COL_${col}`;
          obj[key] = cell.value?.result ?? cell.value ?? null;
        });
        rows.push(obj);
      });
    } else {
      // JSON-Quelle: flexibel viele Formen akzeptieren
      const j0 = items[0].json;
      let arr: any[] | undefined;
      if (Array.isArray(j0)) arr = j0;
      else if (Array.isArray((j0 as any)?.rows)) arr = (j0 as any).rows;
      else if (Array.isArray((j0 as any)?.data)) arr = (j0 as any).data;
      else arr = [j0];

      rows = arr.map((x) => (typeof x === 'object' && x != null ? x : { value: x })) as Record<string, any>[];
      // Header heuristisch: Keys der ersten Zeile
      headers = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    }

    const totalRows = rows.length;

    // -------- IFCTyp-Funktion (Type/ObjectType/IfcType unterstützen)
    const getIfcType = (r: Record<string, any>) => {
      return (r['IfcType'] ?? r['Type'] ?? r['ObjectType'] ?? r['IFC Type'] ?? r['IFCType'] ?? '') as string;
    };

    // -------- isUnique Vorberechnung je Regel/Feld
    const duplicateIndexByRule = new Map<number, Set<number>>();
    rules.forEach((rule, idx) => {
      if (rule.operator !== 'isUnique') return;
      const seen = new Map<string, number>();
      const dups = new Set<number>();
      for (let i = 0; i < rows.length; i++) {
        const v = getByPath(rows[i], rule.field);
        const k = toStringSafe(v);
        if (!k) continue;
        if (seen.has(k)) {
          dups.add(i);
          dups.add(seen.get(k)!);
        } else {
          seen.set(k, i);
        }
      }
      duplicateIndexByRule.set(idx, dups);
    });

    // -------- Regeln anwenden
    const perRule: Array<{
      index: number;
      title: string;
      field: string;
      operator: Operator;
      pattern?: string;
      color?: string;
      count: number;
      guids: string[];
      hits: Hit[];
    }> = [];

    let totalHits = 0;

    for (let ri = 0; ri < rules.length; ri++) {
      const r = rules[ri];
      const hitList: Hit[] = [];
      const allowedIfc = (r.ifcFilterCsv || '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const restrictIfc = allowedIfc.length > 0;

      const dups = duplicateIndexByRule.get(ri);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (restrictIfc) {
          const typ = String(getIfcType(row) || '').toUpperCase();
          if (!allowedIfc.includes(typ)) continue;
        }

        let isHit = false;
        if (r.operator === 'isUnique') {
          isHit = dups?.has(i) ?? false; // markiere Duplikate
        } else {
          const value = getByPath(row, r.field);
          isHit = testOperator(value, r.operator, r.pattern);
        }

        if (isHit) {
          const guid = toStringSafe(getByPath(row, guidField) ?? row[guidField]);
          hitList.push({ rowIndex: i, guid: guid || undefined });
        }
      }

      const guids = hitList.map((h) => h.guid).filter(Boolean) as string[];
      perRule.push({
        index: ri,
        title: r.title || `Rule ${ri + 1}`,
        field: r.field,
        operator: r.operator,
        pattern: r.pattern,
        color: r.color,
        count: hitList.length,
        guids,
        hits: hitList,
      });
      totalHits += hitList.length;
    }

    // -------- XLSX Report (optional)
    const binaries: Record<string, any> = {};
    if (genXlsx) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Data');

      // Header
      const headerRow = headers.length ? headers : Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      ws.addRow(headerRow);

      // Datensätze
      rows.forEach((r) => {
        const rowVals = headerRow.map((h) => (r[h] != null ? r[h] : ''));
        ws.addRow(rowVals);
      });

      // Spaltenindex ermitteln
      const colIndex = new Map<string, number>();
      headerRow.forEach((h, i) => colIndex.set(h, i + 1));

      // Zellen einfärben (rot) je Regel/Hit in Zielfeld-Spalte
      for (const r of perRule) {
        const col = colIndex.get(r.field);
        if (!col) continue;
        const fillColor = colorNameToArgb(r.color);
        for (const h of r.hits) {
          const excelRow = ws.getRow(h.rowIndex + 2); // +1 Header, +1 exceljs
          const cell = excelRow.getCell(col);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        }
      }

      // Summary
      const ws2 = wb.addWorksheet('Summary');
      ws2.addRow(['Title', 'Field', 'Operator', 'Pattern', 'Color', 'Hits']);
      perRule.forEach((r) => {
        ws2.addRow([r.title, r.field, r.operator, r.pattern ?? '', r.color ?? '', r.count]);
      });

      const xbuf = await wb.xlsx.writeBuffer();
      let xlsBuffer: Buffer;
      if (Buffer.isBuffer(xbuf)) {
        xlsBuffer = xbuf as Buffer;
      } else if (xbuf instanceof ArrayBuffer) {
        xlsBuffer = Buffer.from(new Uint8Array(xbuf));
      } else {
        // Fallback (Node bekommt hier eigentlich Buffer)
        // @ts-ignore
        xlsBuffer = Buffer.from(xbuf);
      }

      const xbin = await this.helpers.prepareBinaryData(xlsBuffer);
      xbin.fileName = `${slug(reportTitle) || 'validation'}.xlsx`;
      xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      binaries['xlsx'] = xbin;
    }

    // -------- CSV per Rule (optional)
    if (genCsv) {
      for (const r of perRule) {
        const lines = ['GUID', ...r.guids];
        const cbuf = Buffer.from(lines.join('\n'), 'utf8');
        const key = `csv_${r.index}`;
        const bin = await this.helpers.prepareBinaryData(cbuf);
        bin.fileName = `${slug(r.title || `rule-${r.index + 1}`)}.csv`;
        bin.mimeType = 'text/csv';
        binaries[key] = bin;
      }
    }

    // -------- JSON Meta (optional)
    const outJson: any = {
      title: reportTitle,
      totalRows,
      totalRules: rules.length,
      totalHits,
      perRule: perRule.map((r) => ({
        index: r.index,
        title: r.title,
        field: r.field,
        operator: r.operator,
        pattern: r.pattern,
        color: r.color,
        count: r.count,
        guids: r.guids,
      })),
      // Alias für Downstream (z.B. SmartViews Builder)
      rules: perRule.map((r) => ({
        title: r.title,
        field: r.field,
        operator: r.operator,
        pattern: r.pattern,
        color: r.color,
        guids: r.guids,
      })),
      guidField,
    };

    const resultItem: INodeExecutionData = {
      json: genJson ? outJson : { ok: true },
      binary: Object.keys(binaries).length ? binaries : undefined,
    };

    return [[resultItem]];
  }
}
