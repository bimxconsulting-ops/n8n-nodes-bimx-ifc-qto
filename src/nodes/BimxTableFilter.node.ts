// src/nodes/BimxTableFilter.node.ts
import type { IExecuteFunctions, INodeType, INodeTypeDescription, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import * as XLSX from 'xlsx';

type Rule = {
  column: string;
  operator: 'eq'|'neq'|'contains'|'ncontains'|'gt'|'gte'|'lt'|'lte'|'in'|'nin'|'regex';
  value: string;
  caseInsensitive?: boolean;
  numeric?: boolean;
};

export class BimxTableFilter implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Table Filter',
    name: 'bimxTableFilter',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description: 'Filter a table (JSON/XLSX/TSV) by column values and operators',
    defaults: { name: 'BIM X – Table Filter' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        options: [
          { name: 'Auto (JSON rows or binary)', value: 'auto' },
          { name: 'JSON (items[0].json.rows)', value: 'json' },
          { name: 'Binary XLSX', value: 'xlsx' },
          { name: 'Binary TSV', value: 'tsv' },
        ],
        default: 'auto',
      },
      { displayName: 'Binary Property (when XLSX/TSV)', name: 'binaryProperty', type: 'string', default: 'xlsx' },
      {
        displayName: 'Combine Rules With',
        name: 'combine',
        type: 'options',
        options: [{ name: 'AND (all must match)', value: 'and' }, { name: 'OR (any matches)', value: 'or' }],
        default: 'and',
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
              { displayName: 'Column', name: 'column', type: 'string', default: '' },
              {
                displayName: 'Operator',
                name: 'operator',
                type: 'options',
                options: [
                  { name: 'Equals', value: 'eq' },
                  { name: 'Not equals', value: 'neq' },
                  { name: 'Contains', value: 'contains' },
                  { name: 'Not contains', value: 'ncontains' },
                  { name: '>', value: 'gt' },
                  { name: '>=', value: 'gte' },
                  { name: '<', value: 'lt' },
                  { name: '<=', value: 'lte' },
                  { name: 'In (comma list)', value: 'in' },
                  { name: 'Not in (comma list)', value: 'nin' },
                  { name: 'Regex', value: 'regex' },
                ],
                default: 'eq',
              },
              { displayName: 'Value', name: 'value', type: 'string', default: '' },
              { displayName: 'Case-insensitive', name: 'caseInsensitive', type: 'boolean', default: true },
              { displayName: 'Treat as number', name: 'numeric', type: 'boolean', default: false },
            ],
          },
        ],
      },
      { displayName: 'Return XLSX', name: 'xlsx', type: 'boolean', default: true },
      { displayName: 'Return TSV', name: 'tsv', type: 'boolean', default: false },
      { displayName: 'Return JSON (rows)', name: 'jsonOut', type: 'boolean', default: true },
    ],
  };

  private parseTSV(buf: Buffer) {
    const text = buf.toString('utf8').replace(/\r\n/g, '\n');
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return [];
    const headers = lines[0].split('\t');
    return lines.slice(1).map(line => {
      const cols = line.split('\t');
      const row: Record<string, any> = {};
      headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
      return row;
    });
  }

  private loadRowsFromItem(item: INodeExecutionData, source: string, binProp: string): any[] {
    if (source === 'json' || (source === 'auto' && (item.json as any)?.rows)) {
      return Array.isArray((item.json as any).rows) ? (item.json as any).rows : [];
    }
    if (source === 'xlsx' || (source === 'auto' && item.binary?.[binProp]?.fileName?.endsWith('.xlsx'))) {
      const b = item.binary?.[binProp]; if (!b?.data) return [];
      const buf = Buffer.from(b.data as string, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      return XLSX.utils.sheet_to_json(ws);
    }
    if (source === 'tsv' || (source === 'auto' && item.binary?.[binProp]?.fileName?.endsWith('.tsv'))) {
      const b = item.binary?.[binProp]; if (!b?.data) return [];
      const buf = Buffer.from(b.data as string, 'base64');
      return this.parseTSV(buf);
    }
    return [];
  }

  private makePredicate(rule: Rule) {
    const { operator, value, caseInsensitive, numeric } = rule;
    const refList = (operator === 'in' || operator === 'nin')
      ? value.split(',').map(s => caseInsensitive ? s.trim().toLowerCase() : s.trim())
      : null;
    const rx = operator === 'regex' ? new RegExp(value, caseInsensitive ? 'i' : undefined) : null;

    return (cell: any) => {
      let a = cell;
      let b = value;

      if (numeric) {
        const na = Number(a);
        const nb = Number(b);
        if (Number.isFinite(na) && Number.isFinite(nb)) {
          switch (operator) {
            case 'eq': return na === nb;
            case 'neq': return na !== nb;
            case 'gt': return na > nb;
            case 'gte': return na >= nb;
            case 'lt': return na < nb;
            case 'lte': return na <= nb;
            default: return false;
          }
        }
        return false;
      }

      if (typeof a !== 'string') a = String(a ?? '');
      if (caseInsensitive) { a = a.toLowerCase(); b = b.toLowerCase(); }

      switch (operator) {
        case 'eq': return a === b;
        case 'neq': return a !== b;
        case 'contains': return a.includes(b);
        case 'ncontains': return !a.includes(b);
        case 'in': return refList!.includes(a);
        case 'nin': return !refList!.includes(a);
        case 'regex': return rx!.test(String(cell ?? ''));
        default: return false;
      }
    };
  }

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const source = this.getNodeParameter('source', i) as string;
      const binProp = this.getNodeParameter('binaryProperty', i) as string;
      const combine = this.getNodeParameter('combine', i) as 'and'|'or';
      const rulesArr = (this.getNodeParameter('rules', i, {}) as any)?.rule ?? [];
      const wantXlsx = this.getNodeParameter('xlsx', i) as boolean;
      const wantTsv = this.getNodeParameter('tsv', i) as boolean;
      const wantJson = this.getNodeParameter('jsonOut', i) as boolean;

      const rules: Rule[] = rulesArr.map((r: any) => ({
        column: r.column, operator: r.operator, value: r.value,
        caseInsensitive: !!r.caseInsensitive, numeric: !!r.numeric,
      })).filter(r => r.column);

      const rows = this.loadRowsFromItem(items[i], source, binProp);
      if (!Array.isArray(rows)) {
        throw new NodeOperationError(this.getNode(), 'No rows found to filter', { itemIndex: i });
      }

      const preds = rules.map(r => ({ col: r.column, test: this.makePredicate(r) }));
      const filtered = rows.filter(row => {
        if (!preds.length) return true;
        const results = preds.map(p => p.test((row as any)[p.col]));
        return combine === 'and' ? results.every(Boolean) : results.some(Boolean);
      });

      const newItem: INodeExecutionData = { json: {}, binary: {} };

      if (wantJson) {
        newItem.json = { rows: filtered };
      }

      if (wantXlsx && filtered.length) {
        const ws = XLSX.utils.json_to_sheet(filtered);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Filtered');
        const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;
        const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
        xbin.fileName = 'filtered.xlsx';
        xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        newItem.binary!['xlsx'] = xbin;
      }

      if (wantTsv && filtered.length) {
        const headers = Object.keys(filtered[0] ?? {});
        const lines = [
          headers.join('\t'),
          ...filtered.map(r => headers.map(h => String((r as any)[h] ?? '')).join('\t')),
        ];
        const tbin = await this.helpers.prepareBinaryData(Buffer.from(lines.join('\n'), 'utf8'));
        tbin.fileName = 'filtered.tsv';
        tbin.mimeType = 'text/tab-separated-values';
        newItem.binary!['tsv'] = tbin;
      }

      out.push(newItem);
    }

    return this.prepareOutputData(out);
  }
}
