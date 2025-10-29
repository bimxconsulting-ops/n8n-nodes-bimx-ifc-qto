// src/nodes/BimxWatch.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';

function inferType(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') {
    if (!isNaN(Number(v)) && v.trim() !== '') return 'number|string';
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'date|string';
    return 'string';
  }
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

function toPlainObject(
  o: any,
  maxDepth = 2,
  prefix = '',
  out: Record<string, any> = {},
) {
  if (o == null || typeof o !== 'object' || maxDepth < 0) {
    out[prefix || 'value'] = o;
    return out;
  }
  const isArr = Array.isArray(o);
  const keys = isArr ? Object.keys(o) : Object.keys(o as object);
  if (!keys.length) {
    out[prefix || 'value'] = isArr ? [] : {};
    return out;
  }
  for (const k of keys) {
    const key = isArr ? String(k) : k;
    const val: any = (o as any)[key];
    const next = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && maxDepth > 0) {
      toPlainObject(val, maxDepth - 1, next, out);
    } else {
      out[next] = val;
    }
  }
  return out;
}

export class BimxWatch implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Watch',
    name: 'bimxWatch',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description:
      'Schneller Datenblick: Vorschau, Schema, optionale HTML-Übersicht',
    defaults: { name: 'BIM X – Watch' },
    inputs: ['main'],
    outputs: ['main', 'main'],
    properties: [
      {
        displayName: 'Sample Mode',
        name: 'sampleMode',
        type: 'options',
        default: 'firstN',
        options: [
          { name: 'First N', value: 'firstN' },
          { name: 'Last N', value: 'lastN' },
          { name: 'Random N', value: 'randomN' },
        ],
      },
      {
        displayName: 'Sample Size',
        name: 'sampleSize',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 2000 },
        default: 20,
      },
      {
        displayName: 'Max String Length',
        name: 'maxStringLen',
        type: 'number',
        default: 200,
      },
      {
        displayName: 'Infer Types',
        name: 'inferTypes',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Include Schema',
        name: 'includeSchema',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Output Meta Only (no pass-through)',
        name: 'outputMetaOnly',
        type: 'boolean',
        default: false,
      },

      // ---------- HTML Preview section ----------
      {
        displayName: 'Emit HTML Preview',
        name: 'emitHtml',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Group By Column (for chart)',
        name: 'groupBy',
        type: 'string',
        default: '',
        description: 'Leer lassen für Auto-Auswahl',
        displayOptions: { show: { emitHtml: [true] } },
      },
      {
        displayName: 'Table Row Limit',
        name: 'tableLimit',
        type: 'number',
        default: 200,
        typeOptions: { minValue: 1, maxValue: 5000 },
        displayOptions: { show: { emitHtml: [true] } },
      },
      {
        displayName: 'Report Title',
        name: 'reportTitle',
        type: 'string',
        default: 'BIM X – Watch Preview',
        displayOptions: { show: { emitHtml: [true] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();

    // ---- parameters (with safe defaults) ----
    const sampleMode = this.getNodeParameter('sampleMode', 0) as
      | 'firstN'
      | 'lastN'
      | 'randomN';
    const sampleSize = this.getNodeParameter('sampleSize', 0) as number;
    const maxStringLen = this.getNodeParameter('maxStringLen', 0) as number;
    const inferTypesFlag = this.getNodeParameter('inferTypes', 0) as boolean;
    const includeSchema = this.getNodeParameter('includeSchema', 0) as boolean;
    const outputMetaOnly = this.getNodeParameter('outputMetaOnly', 0) as boolean;

    const emitHtml = this.getNodeParameter('emitHtml', 0) as boolean;
    // IMPORTANT: provide defaults even if property is hidden
    const groupBy = this.getNodeParameter('groupBy', 0, '') as string;
    const tableLimit = this.getNodeParameter('tableLimit', 0, 200) as number;
    const reportTitle = this.getNodeParameter(
      'reportTitle',
      0,
      'BIM X – Watch Preview',
    ) as string;

    // ---- derive row data ----
    // case A: one item with json.rows (array)
    let rows: Array<Record<string, any>> = [];
    if (items.length === 1 && Array.isArray(items[0]?.json?.rows)) {
      // Use the provided table
      const arr = items[0].json.rows as Array<any>;
      rows = arr.map((r) => toPlainObject(r, 1));
    } else {
      // case B: use incoming items as rows
      rows = items.map((it) => toPlainObject(it.json ?? {}, 1));
    }

    const totalRows = rows.length;

    // ---- sampling indices ----
    const n = Math.min(sampleSize, Math.max(0, totalRows));
    let indices: number[] = [];
    if (n > 0) {
      if (sampleMode === 'firstN') {
        indices = Array.from({ length: n }, (_, i) => i);
      } else if (sampleMode === 'lastN') {
        indices = Array.from({ length: n }, (_, i) => totalRows - n + i);
      } else {
        const set = new Set<number>();
        while (set.size < n) set.add(Math.floor(Math.random() * totalRows));
        indices = Array.from(set.values());
      }
    }

    // ---- truncate long strings for preview ----
    const previewRows = indices.map((i) => {
      const data = { ...(rows[i] || {}) };
      for (const k of Object.keys(data)) {
        const v = (data as any)[k];
        if (typeof v === 'string' && v.length > maxStringLen) {
          (data as any)[k] = v.slice(0, maxStringLen) + '…';
        }
      }
      return data;
    });

    // ---- schema + fill rate ----
    const schema: Record<
      string,
      { types: Record<string, number>; nulls: number; uniques: number }
    > = {};
    const fillRate: Record<string, number> = {};
    if (includeSchema && totalRows > 0) {
      const allKeys = new Set<string>();
      rows.forEach((r) => Object.keys(r).forEach((k) => allKeys.add(k)));
      for (const k of allKeys) {
        const typesCount: Record<string, number> = {};
        const seen = new Set<string>();
        let nulls = 0;
        let filled = 0;
        for (const r of rows) {
          const v = (r as any)[k];
          if (v === null || v === undefined || v === '') {
            nulls++;
          } else {
            filled++;
            const t = inferTypesFlag ? inferType(v) : typeof v;
            typesCount[t] = (typesCount[t] || 0) + 1;
            if (['string', 'number', 'boolean'].includes(typeof v))
              seen.add(String(v));
          }
        }
        schema[k] = { types: typesCount, nulls, uniques: seen.size };
        fillRate[k] = Math.round((filled / totalRows) * 100);
      }
    }

    // ---- group counts (for chart) ----
    const norm = (s?: string) => (s ?? '').toLowerCase().trim();

    const pickGroupKey = (): string => {
      if (!totalRows) return '';

      // Alle Keys aus allen Zeilen sammeln
      const allKeys = new Set<string>();
      for (const r of rows) Object.keys(r).forEach((k) => allKeys.add(k));

      // Wenn groupBy gesetzt: erst exact (normiert), dann Teiltreffer versuchen
      if (groupBy) {
        const exact = [...allKeys].find((k) => norm(k) === norm(groupBy));
        if (exact) return exact;
        const partial = [...allKeys].find((k) =>
          norm(k).includes(norm(groupBy)),
        );
        if (partial) return partial;
      }

      // Auto-Pick: erste String-Spalte
      const sample = rows.find((r) => r && Object.keys(r).length) || rows[0];
      const keys = Object.keys(sample || {});
      for (const k of keys) if (typeof (sample as any)[k] === 'string') return k;
      return keys[0] || '';
    };

    const groupKey = totalRows > 0 ? pickGroupKey() : '';
    const groupCounts: Record<string, number> = {};
    if (groupKey) {
      for (const r of rows) {
        const raw = (r as any)[groupKey];
        const key =
          raw === null || raw === undefined || raw === '' ? '(empty)' : String(raw);
        groupCounts[key] = (groupCounts[key] || 0) + 1;
      }
    }

    // ---- meta json for output 2 ----
    const meta: any = {
      watch: {
        totalItems: totalRows,
        sampleMode,
        sampleSize: n,
        preview: previewRows,
        schema: includeSchema ? schema : undefined,
        fillRate,
        groupBy: groupKey || null,
        groupCounts,
      },
    };

    const out2: INodeExecutionData = { json: meta };

    // ---- optional HTML preview (binary) ----
    if (emitHtml) {
      const now = new Date().toLocaleString('de-DE');
      const cols = Object.keys(previewRows[0] || {});
      const limited = previewRows.slice(0, Math.max(1, tableLimit));

      // chart data
      const groupLabels = Object.keys(groupCounts);
      const groupValues = groupLabels.map((k) => groupCounts[k]);

      const fillLabels = Object.keys(fillRate);
      const fillValues = fillLabels.map((k) => fillRate[k]);

      // small HTML (no images, pure client-side chart.js)
      const tableHead = `<tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr>`;
      const tableBody = limited
        .map((row) => {
          const tds = cols.map((c) => {
            const v = (row as any)[c];
            if (v === null || v === undefined) return '<td></td>';
            return `<td>${String(v).replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[m])}</td>`;
          });
          return `<tr>${tds.join('')}</tr>`;
        })
        .join('');

      const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${reportTitle}</title>
<style>
  :root{
    --card:#ffffff; --ink:#111827; --muted:#6b7280; --border:#e5e7eb;
    --shadow:0 18px 40px rgba(2,6,23,.12); --soft:0 10px 22px rgba(2,6,23,.08);
  }
  *{box-sizing:border-box}
  html,body{margin:0; font-family:Inter,system-ui,Segoe UI,Roboto,Arial}
  body{background:#f5f7ff; color:#111827; padding:22px 14px; -webkit-print-color-adjust:exact; print-color-adjust:exact}
  .container{max-width:1100px; margin:0 auto; background:var(--card); border:1px solid var(--border); border-radius:18px; overflow:hidden; box-shadow:var(--shadow)}
  .hero{
    background:
      radial-gradient(120% 80% at 50% 120%, rgba(166,11,36,.38), transparent 60%),
      linear-gradient(180deg, #060606 0%, #0f1115 45%, #1b1e24 100%);
    color:#fff; padding:28px 20px 20px
  }
  .hero h1{margin:0 0 6px; font-weight:900; font-size:24px; text-align:center}
  .hero p{margin:2px 0 0; opacity:.95; text-align:center; font-size:14px}

  .summary{display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); padding:16px; background:#f9fafb; border-bottom:1px solid var(--border)}
  .kpi{background:#fff; border-radius:16px; padding:16px; border:1px solid var(--border); box-shadow:var(--soft); position:relative; overflow:hidden}
  .kpi::before{content:""; position:absolute; left:0; top:0; bottom:0; width:6px; background:#0d6b98}
  .kpi h3{margin:0 0 6px; font-size:.86rem; letter-spacing:.5px; color:#344256; text-transform:uppercase}
  .kpi .value{font-size:1.8rem; font-weight:900; color:#0f172a; line-height:1}
  .kpi .unit{font-size:.82rem; color:#64748b}

  .section{padding:18px 20px}
  .section h2{margin:0 0 12px; text-align:center; font-size:20px; font-weight:900}
  .section h2::after{content:""; display:block; width:180px; height:8px; border-radius:8px; margin:10px auto 0;
    background:linear-gradient(90deg, #a60b24, #6b243d, #4b3953, #35344c, #343f59, #135070, #0d6b98)}

  .charts{display:grid; grid-template-columns:1fr 1fr; gap:16px}
  .chart-card{
    background:#fff; border:1px solid var(--border); border-radius:14px; box-shadow:var(--soft);
    padding:10px 12px 14px; height:260px; display:flex; flex-direction:column; overflow:hidden;
  }
  .chart-card h3{margin:4px 8px 10px; font-size:1rem; color:#334155}
  .chart-card canvas{display:block; width:100% !important; height:100% !important}

  .table-wrap{ border:1px solid var(--border); border-radius:12px; overflow:auto; -webkit-overflow-scrolling:touch }
  table{ min-width:720px; width:100%; border-collapse:separate; border-spacing:0; background:#fff; color:#111827 }
  thead th{ position:sticky; top:0; z-index:1; background:linear-gradient(180deg,#f3f6ff,#eaf0ff); color:#1f2b4d; border-bottom:1px solid var(--border); padding:10px; text-align:left; font-size:.86rem }
  tbody td{ padding:10px; border-bottom:1px solid var(--border) }
  tbody tr:nth-child(even){ background:#fbfdff }
  tbody tr:hover{ background:#f0f6ff }

  @media (max-width:640px){
    .charts{grid-template-columns:1fr; gap:12px}
    .chart-card{height:200px}
    table{min-width:540px}
  }
</style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <h1>${reportTitle}</h1>
      <p>Quick preview generated ${now}</p>
    </div>

    <div class="summary">
      <div class="kpi"><h3>Items</h3><div class="value">${totalRows}</div></div>
      <div class="kpi"><h3>Columns</h3><div class="value">${cols.length}</div></div>
      <div class="kpi"><h3>Group by</h3><div class="value" style="font-size:1.1rem">${groupKey || '(auto n/a)'}</div></div>
    </div>

    <div class="section">
      <h2>Charts</h2>
      <div class="charts">
        <div class="chart-card">
          <h3>Counts by “${groupKey || '—'}”</h3>
          <canvas id="chartGroup"></canvas>
        </div>
        <div class="chart-card">
          <h3>Fill rate by column [%]</h3>
          <canvas id="chartFill"></canvas>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Table Preview (${limited.length} rows)</h2>
      <div class="table-wrap">
        <table>
          <thead>${tableHead}</thead>
          <tbody>${tableBody}</tbody>
        </table>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const groupLabels = ${JSON.stringify(groupLabels)};
    const groupValues = ${JSON.stringify(groupValues)};
    const fillLabels  = ${JSON.stringify(fillLabels)};
    const fillValues  = ${JSON.stringify(fillValues)};

    const stops = ['#a60b24','#6b243d','#4b3953','#35344c','#343f59','#135070','#0d6b98'];
    function palette(n){
      if(n<=stops.length) return stops.slice(0,n);
      const out=[], seg=stops.length-1;
      for(let i=0;i<n;i++){
        const t=i/(n-1), pos=t*seg, i0=Math.floor(pos), f=pos-i0;
        const hexToRgb = h => ({ r:parseInt(h.slice(1,3),16), g:parseInt(h.slice(3,5),16), b:parseInt(h.slice(5,7),16) });
        const c0=hexToRgb(stops[i0]), c1=hexToRgb(stops[Math.min(i0+1,seg)]);
        const r=Math.round(c0.r+(c1.r-c0.r)*f);
        const g=Math.round(c0.g+(c1.g-c0.g)*f);
        const b=Math.round(c0.b+(c1.b-c0.b)*f);
        out.push('#'+[r,g,b].map(x=>x.toString(16).padStart(2,'0')).join(''));
      }
      return out;
    }
    function commonOpts(){ return {
      responsive:true, maintainAspectRatio:false,
      layout:{ padding:{ top:8, right:8, bottom:28, left:8 } },
      plugins:{ legend:{ display:false } },
      scales:{ x:{ ticks:{ color:'#334155', maxRotation:0, autoSkip:true, padding:8 } },
              y:{ ticks:{ color:'#334155' } } }
    }; }

    // group chart
    (function(){
      const el = document.getElementById('chartGroup').getContext('2d');
      const colors = palette(groupLabels.length || 1);
      new Chart(el, {
        type: 'bar',
        data: { labels: groupLabels, datasets:[{ data: groupValues, backgroundColor: colors }] },
        options: commonOpts(),
      });
    })();

    // fill chart
    (function(){
      const el = document.getElementById('chartFill').getContext('2d');
      const colors = palette(fillLabels.length || 1).reverse();
      new Chart(el, {
        type: 'bar',
        data: { labels: fillLabels, datasets:[{ data: fillValues, backgroundColor: colors }] },
        options: commonOpts(),
      });
    })();
  </script>
</body>
</html>`;

      const buf = Buffer.from(html, 'utf8');
      const bin = await this.helpers.prepareBinaryData(buf);
      (bin as any).fileName = 'bimx_watch_preview.html';
      (bin as any).mimeType = 'text/html';
      (out2 as any).binary = { html: bin };
    }

    // output 1 (pass-through) + output 2 (meta/preview)
    const out1 = outputMetaOnly ? [] : items;
    return [out1, [out2]];
  }
}
