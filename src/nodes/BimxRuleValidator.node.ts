// src/nodes/BimxRuleValidator.node.ts
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import * as XLSX from 'xlsx';
import ExcelJS from 'exceljs';

// --- kleine Utils ---
const toStr = (v: any) => (v === null || v === undefined) ? '' : String(v);
const asNum = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const guessGuidKey = (row: Record<string, any>) => {
  const keys = Object.keys(row || {});
  const cand = ['GlobalId','GlobalID','GUID','Guid','IfcGuid','ifcGuid','Global_Id'];
  return cand.find(k => keys.includes(k));
};
const hexToRGB = (hex: string) => {
  const h = (hex || '').replace('#','').trim();
  if (h.length !== 6) return { r: 255, g: 0, b: 0 };
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
};

// Rule Operator
type Op =
  | 'equals' | 'notEquals'
  | 'contains' | 'notContains'
  | 'regex'
  | 'isEmpty' | 'isNotEmpty'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'eqNumber'
  | 'inList'
  | 'lengthEquals'
  | 'notUnique';

interface RuleDef {
  title: string;
  field: string;
  operator: Op;
  value?: string;
  useRegex?: boolean;
  ifcType?: string;
  valueType?: string;
  severity?: 'info'|'warning'|'error';
  colorHex?: string; // overrides severity color
}

interface RuleHit {
  ruleIndex: number;
  title: string;
  field: string;
  operator: Op;
  value?: string;
  ifcType?: string;
  valueType?: string;
  severity: 'info'|'warning'|'error';
  colorHex: string;
  count: number;
  guids: string[];
  rows: number[]; // indices
}

export class BimxRuleValidator implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Excel Rule Validator',
    name: 'bimxRuleValidator',
    group: ['transform'],
    version: 1,
    description: 'Validate a table (JSON/XLSX) by multiple rules → XLSX report with highlights + GUID lists.',
    defaults: { name: 'BIM X – Rule Validator' },
    icon: 'file:BIMX.svg',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      // Source
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        default: 'auto',
        options: [
          { name: 'Auto (rows[] or items)', value: 'auto' },
          { name: 'JSON (items)', value: 'json' },
          { name: 'XLSX (binary)', value: 'xlsx' },
        ],
      },
      {
        displayName: 'Binary Property (XLSX)',
        name: 'binaryProperty',
        type: 'string',
        default: 'xlsx',
        description: 'Only used when Source=XLSX',
      },

      // GUID detection
      {
        displayName: 'GUID Field',
        name: 'guidField',
        type: 'string',
        default: '',
        description: 'Optional: override GUID column name (auto-detected if empty)',
      },

      // Rules
      {
        displayName: 'Rules',
        name: 'rules',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add rule',
        default: {},
        options: [
          {
            name: 'rule',
            displayName: 'Rule',
            values: [
              { displayName: 'Title', name: 'title', type: 'string', default: '' },
              { displayName: 'Field', name: 'field', type: 'string', default: '' },
              {
                displayName: 'Operator',
                name: 'operator',
                type: 'options',
                default: 'isEmpty',
                options: [
                  { name: 'Equals', value: 'equals' },
                  { name: 'Not Equals', value: 'notEquals' },
                  { name: 'Contains', value: 'contains' },
                  { name: 'Not Contains', value: 'notContains' },
                  { name: 'Regex', value: 'regex' },
                  { name: 'Is Empty', value: 'isEmpty' },
                  { name: 'Is Not Empty', value: 'isNotEmpty' },
                  { name: '== Number', value: 'eqNumber' },
                  { name: '> Number', value: 'gt' },
                  { name: '>= Number', value: 'gte' },
                  { name: '< Number', value: 'lt' },
                  { name: '<= Number', value: 'lte' },
                  { name: 'In List (comma-separated)', value: 'inList' },
                  { name: 'Length Equals', value: 'lengthEquals' },
                  { name: 'Duplicates (Not Unique)', value: 'notUnique' },
                ],
              },
              { displayName: 'Value / Regex / List', name: 'value', type: 'string', default: '' },
              { displayName: 'Use Regex (for contains/equals)', name: 'useRegex', type: 'boolean', default: false },
              { displayName: 'IFC Type (meta)', name: 'ifcType', type: 'string', default: 'Any' },
              { displayName: 'Value Type (meta)', name: 'valueType', type: 'string', default: 'StringValue' },
              {
                displayName: 'Severity',
                name: 'severity',
                type: 'options',
                default: 'error',
                options: [
                  { name: 'Info (blue)', value: 'info' },
                  { name: 'Warning (yellow)', value: 'warning' },
                  { name: 'Error (red)', value: 'error' },
                ],
              },
              {
                displayName: 'Color Override (#RRGGBB)',
                name: 'colorHex',
                type: 'string',
                default: '',
              },
            ],
          },
        ],
      },

      // Output config
      { displayName: 'Report Title', name: 'reportTitle', type: 'string', default: 'Validation Report' },
      { displayName: 'Emit XLSX Report', name: 'emitXlsx', type: 'boolean', default: true },
      { displayName: 'Emit CSV (GUID hits)', name: 'emitCsv', type: 'boolean', default: true },
      { displayName: 'Pass Through Items', name: 'passThrough', type: 'boolean', default: false },
    ],
  };

  private matchRule(op: Op, cellValue: any, raw: string, useRegex: boolean, ctx: { counts?: Map<string, number> }): boolean {
    const s = toStr(cellValue);
    switch (op) {
      case 'equals':
        return useRegex ? new RegExp(raw).test(s) : s === raw;
      case 'notEquals':
        return useRegex ? !new RegExp(raw).test(s) : s !== raw;
      case 'contains':
        return useRegex ? new RegExp(raw).test(s) : s.includes(raw);
      case 'notContains':
        return useRegex ? !new RegExp(raw).test(s) : !s.includes(raw);
      case 'regex':
        return new RegExp(raw).test(s);
      case 'isEmpty':
        return s.trim() === '';
      case 'isNotEmpty':
        return s.trim() !== '';
      case 'eqNumber':
        return Number.isFinite(asNum(s)) && asNum(s) === asNum(raw);
      case 'gt':
        return Number.isFinite(asNum(s)) && Number.isFinite(asNum(raw)) && asNum(s) > asNum(raw);
      case 'gte':
        return Number.isFinite(asNum(s)) && Number.isFinite(asNum(raw)) && asNum(s) >= asNum(raw);
      case 'lt':
        return Number.isFinite(asNum(s)) && Number.isFinite(asNum(raw)) && asNum(s) < asNum(raw);
      case 'lte':
        return Number.isFinite(asNum(s)) && Number.isFinite(asNum(raw)) && asNum(s) <= asNum(raw);
      case 'inList': {
        const parts = (raw || '').split(',').map(v => v.trim()).filter(Boolean);
        return parts.includes(s);
      }
      case 'lengthEquals':
        return s.length === asNum(raw);
      case 'notUnique': {
        const counts = ctx.counts || new Map<string, number>();
        const c = counts.get(s) || 0;
        return s !== '' && c > 1; // mark only duplicates (value appears more than once)
      }
      default:
        return false;
    }
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const source = this.getNodeParameter('source', 0) as 'auto'|'json'|'xlsx';
    const binaryProperty = this.getNodeParameter('binaryProperty', 0) as string;
    const guidFieldParam = this.getNodeParameter('guidField', 0) as string;

    const rulesArr: RuleDef[] = ((this.getNodeParameter('rules', 0, {}) as any).rule || []).map((r: any) => ({
      title: r.title || '',
      field: r.field || '',
      operator: r.operator as Op,
      value: r.value ?? '',
      useRegex: !!r.useRegex,
      ifcType: r.ifcType || 'Any',
      valueType: r.valueType || 'StringValue',
      severity: (r.severity || 'error') as 'info'|'warning'|'error',
      colorHex: (r.colorHex || '').trim(),
    }));

    const reportTitle = this.getNodeParameter('reportTitle', 0) as string;
    const emitXlsx = this.getNodeParameter('emitXlsx', 0) as boolean;
    const emitCsv = this.getNodeParameter('emitCsv', 0) as boolean;
    const passThrough = this.getNodeParameter('passThrough', 0) as boolean;

    if (!rulesArr.length) {
      throw new NodeOperationError(this.getNode(), 'Please add at least one rule.');
    }

    // ---- load rows (auto/json/xlsx) ----
    let rows: Array<Record<string, any>> = [];
    if (source === 'xlsx') {
      const bin = items[0]?.binary?.[binaryProperty];
      if (!bin?.data) throw new NodeOperationError(this.getNode(), `Binary property "${binaryProperty}" missing`);
      const buf = Buffer.from(bin.data as string, 'base64');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const sheetName = wb.SheetNames[0];
      const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' }) as any[];
      rows = json.map(o => ({ ...o }));
    } else {
      // auto/json
      if (items.length === 1 && Array.isArray((items[0].json as any)?.rows)) {
        rows = (items[0].json as any).rows as any[];
      } else {
        rows = items.map(it => ({ ...(it.json || {}) }));
      }
    }

    const totalRows = rows.length;
    if (!totalRows) {
      throw new NodeOperationError(this.getNode(), 'No rows found (empty input).');
    }

    // unified header
    const headers = Array.from(
      rows.reduce((s, r) => { Object.keys(r||{}).forEach(k => s.add(k)); return s; }, new Set<string>())
    );

    // GUID detection
    let guidKey = guidFieldParam?.trim();
    if (!guidKey) {
      guidKey = guessGuidKey(rows[0] || '') || 'GUID';
    }

    // Precompute counts for 'notUnique' rules (per field)
    const uniqueCounts: Record<string, Map<string, number>> = {};
    for (const rule of rulesArr) {
      if (rule.operator === 'notUnique') {
        const m = new Map<string, number>();
        for (const r of rows) {
          const val = toStr(r?.[rule.field]);
          m.set(val, (m.get(val) || 0) + 1);
        }
        uniqueCounts[rule.field] = m;
      }
    }

    // Severity → default color
    const sevColor: Record<'info'|'warning'|'error', string> = {
      info: '#60a5fa',     // blue-400
      warning: '#fde047',  // yellow-300
      error: '#f87171',    // red-400
    };

    // evaluate rules
    const hits: RuleHit[] = rulesArr.map((rule, idx) => ({
      ruleIndex: idx,
      title: rule.title || `Rule ${idx+1}`,
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      ifcType: rule.ifcType || 'Any',
      valueType: rule.valueType || 'StringValue',
      severity: (rule.severity || 'error'),
      colorHex: rule.colorHex || sevColor[rule.severity || 'error'],
      count: 0,
      guids: [],
      rows: [],
    }));

    rows.forEach((row, i) => {
      rulesArr.forEach((rule, ri) => {
        const ctx = { counts: uniqueCounts[rule.field] };
        const ok = this.matchRule(rule.operator, row?.[rule.field], rule.value || '', !!rule.useRegex, ctx);
        if (ok) {
          const g = toStr(row?.[guidKey]) || `row-${i+1}`;
          hits[ri].count++;
          hits[ri].rows.push(i);
          if (!hits[ri].guids.includes(g)) hits[ri].guids.push(g);
        }
      });
    });

    // ---- Build XLSX report ----
    let xlsxBin: Buffer | undefined;
    if (emitXlsx) {
      const wb = new ExcelJS.Workbook();
      wb.creator = 'BIM X';
      wb.created = new Date();

      // Summary
      const wsS = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
      wsS.columns = [
        { header: 'Report', key: 'report', width: 30 },
        { header: 'Rule', key: 'rule', width: 36 },
        { header: 'Field', key: 'field', width: 24 },
        { header: 'Operator', key: 'op', width: 16 },
        { header: 'Value', key: 'val', width: 28 },
        { header: 'IFC Type', key: 'ifc', width: 14 },
        { header: 'Value Type', key: 'vtype', width: 14 },
        { header: 'Severity', key: 'sev', width: 10 },
        { header: 'Color', key: 'color', width: 12 },
        { header: 'Hits', key: 'hits', width: 8 },
        { header: 'Sample GUIDs', key: 'guids', width: 60 },
      ];
      hits.forEach(h => {
        const { r,g,b } = hexToRGB(h.colorHex);
        const row = wsS.addRow({
          report: reportTitle,
          rule: h.title,
          field: h.field,
          op: h.operator,
          val: h.value ?? '',
          ifc: h.ifcType,
          vtype: h.valueType,
          sev: h.severity,
          color: h.colorHex,
          hits: h.count,
          guids: h.guids.slice(0, 50).join(','),
        });
        // color chip cell
        const colCell = row.getCell('color');
        colCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: [r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase() } };
      });
      wsS.getRow(1).font = { bold: true };

      // Data sheet
      const wsD = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
      wsD.addRow(headers);
      wsD.getRow(1).font = { bold: true };
      wsD.columns = headers.map(h => ({ header: h, key: h, width: Math.min(40, Math.max(12, (h || '').length + 2)) }));

      // Build a lookup: for each rule, set of rowIndex for quick test
      const hitByRule: Array<Set<number>> = hits.map(h => new Set(h.rows));
      // write rows & color specific cells
      rows.forEach((row, i) => {
        const vals = headers.map(h => row?.[h]);
        const r = wsD.addRow(vals);
        // apply fills for hit cells
        rulesArr.forEach((rule, ri) => {
          if (!hitByRule[ri].has(i)) return;
          const colIndex = headers.indexOf(rule.field);
          if (colIndex >= 0) {
            const { r: rr, g, b } = hexToRGB(hits[ri].colorHex);
            const cell = r.getCell(colIndex + 1);
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: [rr,g,b].map(v=>v.toString(16).padStart(2,'0')).join('').toUpperCase() } };
          }
        });
      });

      const buf = await wb.xlsx.writeBuffer();
      xlsxBin = Buffer.from(buf as ArrayBuffer);
    }

    // ---- GUID CSV (long format) ----
    let csvBin: Buffer | undefined;
    const csvLines: string[] = ['reportTitle,ruleTitle,ifcType,valueType,guid'];
    hits.forEach(h => {
      h.guids.forEach(g => {
        const cols = [
          reportTitle,
          h.title.replace(/"/g,'""'),
          h.ifcType || 'Any',
          h.valueType || 'StringValue',
          g,
        ];
        csvLines.push(cols.map(v => `"${String(v)}"`).join(','));
      });
    });
    if (emitCsv) {
      csvBin = Buffer.from(csvLines.join('\n'), 'utf8');
    }

    // ---- Output item ----
    const out: INodeExecutionData = {
      json: {
        reportTitle,
        totalRows,
        guidField: guidKey,
        rules: hits.map(h => ({
          title: h.title,
          field: h.field,
          operator: h.operator,
          value: h.value,
          ifcType: h.ifcType,
          valueType: h.valueType,
          severity: h.severity,
          colorHex: h.colorHex,
          hits: h.count,
          guids: h.guids,
          rowIndices: h.rows,
        })),
      },
      binary: {},
    };

    if (xlsxBin) {
      const xbin = await this.helpers.prepareBinaryData(xlsxBin);
      xbin.fileName = `${reportTitle.replace(/\s+/g,'_')}_report.xlsx`;
      xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      (out.binary as any)['report'] = xbin;
    }
    if (csvBin) {
      const cbin = await this.helpers.prepareBinaryData(csvBin);
      cbin.fileName = `${reportTitle.replace(/\s+/g,'_')}_rule_hits.csv`;
      cbin.mimeType = 'text/csv';
      (out.binary as any)['hitsCsv'] = cbin;
    }

    const outputs: INodeExecutionData[][] = [];
    outputs[0] = passThrough ? items : [out];
    return outputs;
  }
}
