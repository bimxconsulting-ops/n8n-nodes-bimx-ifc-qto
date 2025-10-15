// src/nodes/BimxRuleValidator.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import * as XLSX from 'xlsx';

/* ---------------------------------- Typen --------------------------------- */

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
  | 'gte';

type ColorName = 'red' | 'yellow' | 'none';

interface Rule {
  title?: string;
  field: string;        // z.B. "Space.Name" oder "Qto.NetFloorArea"
  op: Operator;
  value?: string;
  color?: ColorName;    // (v1 ignoriert – nur für spätere ExcelJS-Highlights)
  ifcType?: string;     // optional: CSV, z.B. "IFCSPACE,IFCDOOR"
}

interface RuleHit {
  ruleIndex: number;
  ruleTitle: string;
  rowIndex: number;
  guid?: string;
}

/* --------------------------------- Helper --------------------------------- */

function getByPath(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function toNum(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function unionHeaders(rows: Array<Record<string, any>>): string[] {
  const set = new Set<string>();
  for (const r of rows) Object.keys(r).forEach(k => set.add(k));
  return Array.from(set.values());
}

function toCsv(rows: Array<Record<string, any>>): string {
  if (!rows.length) return '';
  const headers = unionHeaders(rows);
  const esc = (x: any) => {
    const s = x == null ? '' : String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n');
}

function matches(rule: Rule, row: Record<string, any>): boolean {
  // IFC-Type Filter (optional)
  if (rule.ifcType) {
    const allow = rule.ifcType.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    const t = String(row['IFCType'] ?? row['type'] ?? row['ObjectType'] ?? row['Type'] ?? '').toUpperCase();
    if (allow.length && !allow.includes(t)) return false;
  }

  const raw = getByPath(row, rule.field);
  const val = raw == null ? '' : String(raw);

  switch (rule.op) {
    case 'is':        return val === (rule.value ?? '');
    case 'isNot':     return val !== (rule.value ?? '');
    case 'contains':  return val.includes(rule.value ?? '');
    case 'notContains': return !val.includes(rule.value ?? '');
    case 'regex':
      try { return new RegExp(rule.value ?? '', 'i').test(val); } catch { return false; }
    case 'empty':     return val === '' || val === 'null' || val === 'undefined';
    case 'notEmpty':  return !(val === '' || val === 'null' || val === 'undefined');
    case 'lt': {
      const a = toNum(val), b = toNum(rule.value);
      return a != null && b != null && a < b;
    }
    case 'lte': {
      const a = toNum(val), b = toNum(rule.value);
      return a != null && b != null && a <= b;
    }
    case 'gt': {
      const a = toNum(val), b = toNum(rule.value);
      return a != null && b != null && a > b;
    }
    case 'gte': {
      const a = toNum(val), b = toNum(rule.value);
      return a != null && b != null && a >= b;
    }
  }
}

/* ---------------------------------- Node ---------------------------------- */

export class BimxRuleValidator implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X - Rule Validator',
    name: 'bimxRuleValidator',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description: 'Validiert Tabellen (JSON/XLSX) mit Regeln und erzeugt XLSX-Report (tabellarisch) + GUID-Listen.',
    defaults: { name: 'BIM X - Rule Validator' },
    inputs: ['main'],
    outputs: ['main', 'main'], // 0: Report/Meta, 1: GUID-Listen/CSV
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
        description: 'Nur wenn Source = Binary XLSX',
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
              { displayName: 'Field (JSON path)', name: 'field', type: 'string', default: '' },
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
                ],
              },
              { displayName: 'Value / Pattern', name: 'value', type: 'string', default: '' },
              {
                displayName: 'IFC Type filter (CSV)',
                name: 'ifcType',
                type: 'string',
                default: '',
                description: 'z.B. IFCSPACE,IFCDOOR – leer lassen für alle',
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

      { displayName: 'GUID Field', name: 'guidField', type: 'string', default: 'GlobalId' },
      { displayName: 'Report Title', name: 'reportTitle', type: 'string', default: 'Validation Report' },
      { displayName: 'Generate XLSX Report', name: 'emitXlsx', type: 'boolean', default: true },
      { displayName: 'Generate JSON Meta', name: 'emitJson', type: 'boolean', default: true },
      { displayName: 'Generate CSV (per Rule GUIDs)', name: 'emitCsv', type: 'boolean', default: false },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    const source = this.getNodeParameter('source', 0) as 'items' | 'binary';
    const binaryProperty = this.getNodeParameter('binaryProperty', 0, 'xlsx') as string;

    const rulesColl = this.getNodeParameter('rules', 0, {}) as { rule?: Rule[] };
    const rules: Rule[] = Array.isArray(rulesColl?.rule) ? rulesColl.rule : [];

    const guidField = this.getNodeParameter('guidField', 0) as string;
    const reportTitle = this.getNodeParameter('reportTitle', 0) as string;
    const emitXlsx = this.getNodeParameter('emitXlsx', 0) as boolean;
    const emitJson = this.getNodeParameter('emitJson', 0) as boolean;
    const emitCsv = this.getNodeParameter('emitCsv', 0) as boolean;

    /* --------------------------- Datenbeschaffung -------------------------- */
    const rows: Array<Record<string, any>> = [];

    if (source === 'items') {
      // Entweder items[0].json.rows[] (Tabellenblock) ODER je Item eine Zeile
      if (Array.isArray(items[0]?.json?.rows)) {
        for (const r of (items[0]!.json as any).rows) rows.push(typeof r === 'object' ? r : { value: r });
      } else {
        for (const it of items) rows.push({ ...(it.json || {}) });
      }
    } else {
      const bin = items[0]?.binary?.[binaryProperty];
      if (!bin?.data) throw new Error(`Binary property "${binaryProperty}" not found.`);
      const buf = Buffer.from(bin.data as string, 'base64');

      const wbIn = XLSX.read(buf, { type: 'buffer' });
      const sheetName = wbIn.SheetNames[0];
      const ws = wbIn.Sheets[sheetName];
      if (!ws) throw new Error('No worksheet in XLSX.');
      const arr = XLSX.utils.sheet_to_json<Record<string, any>>(ws, { defval: '' });
      rows.push(...arr);
    }

    /* ------------------------------ Auswertung ----------------------------- */
    const hits: RuleHit[] = [];
    const perRule = rules.map((r, i) => ({ index: i, title: r.title || `Rule ${i + 1}`, count: 0, guids: [] as string[] }));

    rows.forEach((row, rowIndex) => {
      rules.forEach((rule, ruleIndex) => {
        try {
          if (matches(rule, row)) {
            const guid = String(row[guidField] ?? row['GUID'] ?? '');
            hits.push({ ruleIndex, ruleTitle: perRule[ruleIndex].title, rowIndex, guid });
            perRule[ruleIndex].count++;
            if (guid) perRule[ruleIndex].guids.push(guid);
          }
        } catch {/* row-spezifische Fehler ignorieren */}
      });
    });

    /* -------------------------------- Output ------------------------------- */
    const outMain: INodeExecutionData[] = [];
    const outGuid: INodeExecutionData[] = [];

    const meta = {
      title: reportTitle,
      totalRows: rows.length,
      totalRules: rules.length,
      totalHits: hits.length,
      perRule,
    };

    // A) XLSX Report (ohne Formatierung; tabellarisch, + Violations-Spalte)
    if (emitXlsx) {
      const headers = unionHeaders(rows);
      const dataWithViolations = rows.map((r, i) => {
        const titles = hits.filter(h => h.rowIndex === i).map(h => h.ruleTitle);
        return { ...r, Violations: titles.join(' | ') };
      });

      const wb = XLSX.utils.book_new();
      const wsData = [headers.concat('Violations')];
      for (const row of dataWithViolations) {
        wsData.push(headers.map(h => row[h] ?? '').concat(row['Violations'] ?? ''));
      }
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, 'Data');

      // Summary
      const sumHeaders = ['#', 'Rule Title', 'Field', 'Operator', 'Value', 'IFC Filter', 'Color', 'Hits'];
      const sumRows = rules.map((r, idx) => [
        idx + 1,
        perRule[idx].title,
        r.field,
        r.op,
        r.value ?? '',
        r.ifcType ?? '',
        r.color ?? 'red',
        perRule[idx].count,
      ]);
      const wsSum = XLSX.utils.aoa_to_sheet([sumHeaders, ...sumRows]);
      XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

      // GUIDs
      const guidRows = perRule.flatMap(rec => rec.guids.map(g => [rec.index + 1, rec.title, g]));
      const wsGuids = XLSX.utils.aoa_to_sheet([['Rule #', 'Rule Title', 'GUID'], ...guidRows]);
      XLSX.utils.book_append_sheet(wb, wsGuids, 'GUIDs');

      const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;
      const bin = await this.helpers.prepareBinaryData(xbuf);
      bin.fileName = 'validation_report.xlsx';
      bin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

      outMain.push({ json: meta, binary: { report: bin } });
    } else if (emitJson) {
      outMain.push({ json: meta });
    }

    // B) Zweig 2: GUID-Listen (JSON) + optional CSV je Regel
    outGuid.push({ json: { perRule } });
    if (emitCsv) {
      for (const rec of perRule) {
        const csv = toCsv(rec.guids.map(g => ({ rule: rec.title, guid: g })));
        const csvBuf = Buffer.from(csv, 'utf8');
        const bin = await this.helpers.prepareBinaryData(csvBuf);
        bin.fileName = `guids_${(rec.title || `rule_${rec.index + 1}`)}.csv`;
        bin.mimeType = 'text/csv';
        outGuid.push({ json: { rule: rec.title, count: rec.count }, binary: { csv: bin } });
      }
    }

    return [outMain, outGuid];
  }
}
