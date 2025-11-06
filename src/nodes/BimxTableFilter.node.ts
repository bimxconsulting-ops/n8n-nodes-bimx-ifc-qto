// src/nodes/BimxTableFilter.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import * as XLSX from 'xlsx';

/* ----------------------------- Types & Helpers ----------------------------- */

type Logic = 'AND' | 'OR';

interface FilterRule {
  field: string; // z.B. "Storey" oder "Pset_WallCommon.FireRating"
  op:
    | 'eq' | 'neq'
    | 'contains' | 'notContains'
    | 'gt' | 'gte' | 'lt' | 'lte'
    | 'regex'
    | 'isEmpty' | 'isNotEmpty'
    | 'in' | 'nin';
  value?: any;
}

function getByPath(obj: any, path: string) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function asNum(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

export function makePredicate(rules: FilterRule[], logic: Logic) {
  const safeRules = Array.isArray(rules) ? rules : [];
  const mode = logic === 'OR' ? 'OR' : 'AND';

  return (row: any) => {
    const checks = safeRules.map((r) => {
      const v = getByPath(row, r.field);

      switch (r.op) {
        case 'eq':  return String(v) === String(r.value);
        case 'neq': return String(v) !== String(r.value);

        case 'contains':     return String(v ?? '').includes(String(r.value ?? ''));
        case 'notContains':  return !String(v ?? '').includes(String(r.value ?? ''));

        case 'gt':  { const a = asNum(v), b = asNum(r.value); return a !== undefined && b !== undefined && a >  b; }
        case 'gte': { const a = asNum(v), b = asNum(r.value); return a !== undefined && b !== undefined && a >= b; }
        case 'lt':  { const a = asNum(v), b = asNum(r.value); return a !== undefined && b !== undefined && a <  b; }
        case 'lte': { const a = asNum(v), b = asNum(r.value); return a !== undefined && b !== undefined && a <= b; }

        case 'regex':
          try { return new RegExp(String(r.value ?? ''), 'i').test(String(v ?? '')); }
          catch { return false; }

        case 'isEmpty':    return v == null || v === '';
        case 'isNotEmpty': return !(v == null || v === '');

        case 'in': {
          const arr = Array.isArray(r.value)
            ? r.value
            : String(r.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          return arr.some((x) => String(x) === String(v));
        }

        case 'nin': {
          const arr = Array.isArray(r.value)
            ? r.value
            : String(r.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          return !arr.some((x) => String(x) === String(v));
        }

        default:
          return false;
      }
    });

    return mode === 'AND' ? checks.every(Boolean) : checks.some(Boolean);
  };
}

export function loadRowsFromItem(item: INodeExecutionData): any[] {
  // 1) JSON-Varianten
  const j = item.json as any;
  if (Array.isArray(j)) return j;           // direkt Array
  if (Array.isArray(j?.rows)) return j.rows; // in { rows: [...] }

  // 2) XLSX (binary.xlsx)
  const bin = item.binary;
  if (bin?.xlsx?.data) {
    const buf = Buffer.from(bin.xlsx.data as string, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }) as any[];
    return rows;
  }

  // 3) TSV (binary.tsv)
  if (bin?.tsv?.data) {
    const buf = Buffer.from(bin.tsv.data as string, 'base64');
    const txt = buf.toString('utf8');
    const lines = txt.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) return [];
    const headers = lines[0].split('\t');
    return lines.slice(1).map((ln) => {
      const cols = ln.split('\t');
      const obj: Record<string, any> = {};
      headers.forEach((h, i) => (obj[h] = cols[i] ?? ''));
      return obj;
    });
  }

  // 4) Fallback: single row
  if (j && typeof j === 'object' && Object.keys(j).length) return [j];

  return [];
}

/* --------------------------------- Node ------------------------------------ */

export class BimxTableFilter implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Table Filter',
    name: 'bimxTableFilter',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description:
      'Filtert Tabellen (JSON, XLSX oder TSV) anhand von Regeln und gibt die gefilterten Zeilen zurück',
    defaults: { name: 'BIM X – Table Filter' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Logic',
        name: 'logic',
        type: 'options',
        options: [
          { name: 'AND (all rules must match)', value: 'AND' },
          { name: 'OR (any rule may match)', value: 'OR' },
        ],
        default: 'AND',
      },
      {
        displayName: 'Filters',
        name: 'filters',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        options: [
          {
            name: 'rule',
            displayName: 'Rule',
            values: [
              {
                displayName: 'Field',
                name: 'field',
                type: 'string',
                default: '',
                placeholder: 'e.g. Storey or Pset_WallCommon.FireRating',
                required: true,
              },
              {
                displayName: 'Operator',
                name: 'op',
                type: 'options',
                options: [
                  { name: 'Equals', value: 'eq' },
                  { name: 'Not Equals', value: 'neq' },
                  { name: 'Contains', value: 'contains' },
                  { name: 'Not Contains', value: 'notContains' },
                  { name: 'Greater Than', value: 'gt' },
                  { name: 'Greater or Equal', value: 'gte' },
                  { name: 'Less Than', value: 'lt' },
                  { name: 'Less or Equal', value: 'lte' },
                  { name: 'Regex (case-insensitive)', value: 'regex' },
                  { name: 'Is Empty', value: 'isEmpty' },
                  { name: 'Is Not Empty', value: 'isNotEmpty' },
                  { name: 'In (comma-separated)', value: 'in' },
                  { name: 'Not In (comma-separated)', value: 'nin' },
                ],
                default: 'eq',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                displayOptions: {
                  show: {
                    op: [
                      'eq',
                      'neq',
                      'contains',
                      'notContains',
                      'gt',
                      'gte',
                      'lt',
                      'lte',
                      'regex',
                      'in',
                      'nin',
                    ],
                  },
                  hide: {
                    op: ['isEmpty', 'isNotEmpty'],
                  },
                },
              },
            ],
          },
        ],
      },
      {
        displayName: 'Generate XLSX',
        name: 'xlsx',
        type: 'boolean',
        default: false,
        description: 'Erzeugt zusätzlich eine Excel-Datei mit dem Filterergebnis (binary.xlsx)',
      },
      {
        displayName: 'Generate TSV',
        name: 'tsv',
        type: 'boolean',
        default: false,
        description: 'Erzeugt zusätzlich eine TSV-Datei (binary.tsv) mit Tab als Trenner',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const logic = (this.getNodeParameter('logic', i, 'AND') as Logic) ?? 'AND';
      const filtersCollection = (this.getNodeParameter('filters', i, {}) as any) ?? {};
      const wantXlsx = this.getNodeParameter('xlsx', i) as boolean;
      const wantTsv = this.getNodeParameter('tsv', i) as boolean;

      const rulesRaw = Array.isArray(filtersCollection.rule) ? filtersCollection.rule : [];
      const rules: FilterRule[] = rulesRaw.map((r: any) => ({
        field: String(r.field ?? '').trim(),
        op: r.op,
        value: r.value,
      })).filter((r: FilterRule) => r.field && r.op);

      const rows = loadRowsFromItem(items[i]);
      if (!Array.isArray(rows)) {
        throw new NodeOperationError(this.getNode(), 'Input could not be parsed into rows', { itemIndex: i });
      }

      const pred = makePredicate(rules, logic);
      const filtered = rows.filter(pred);

      const newItem: INodeExecutionData = {
        json: { count: filtered.length, rows: filtered },
        binary: {},
      };

      // Optional: XLSX
      if (wantXlsx) {
        const ws = XLSX.utils.json_to_sheet(filtered);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Filtered');
        const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;

        const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
        xbin.fileName = 'filtered.xlsx';
        xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        (newItem.binary as any)['xlsx'] = xbin;
      }

      // Optional: TSV
      if (wantTsv) {
        const headers = Object.keys(filtered[0] ?? {});
        const lines = [
          headers.join('\t'),
          ...filtered.map(rw => headers.map(h => String(rw[h] ?? '')).join('\t')),
        ];
        const tbin = await this.helpers.prepareBinaryData(Buffer.from(lines.join('\n'), 'utf8'));
        tbin.fileName = 'filtered.tsv';
        tbin.mimeType = 'text/tab-separated-values';
        (newItem.binary as any)['tsv'] = tbin;
      }

      out.push(newItem);
    }

    return [out];
  }
}
