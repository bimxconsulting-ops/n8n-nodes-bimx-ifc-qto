// src/nodes/BimxWatch.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';

/** kleine Helfer */
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
const isNullish = (v: any) => v === null || v === undefined;
const esc = (s: any) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export class BimxWatch implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – Watch',
    name: 'bimxWatch',
    group: ['transform'],
    version: 1,
    icon: 'file:BIMX.svg',
    description: 'Tap between nodes to preview items, schema and quick charts',
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

      // ---------- HTML Preview ----------
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
        description:
          'Optional column to aggregate counts by (e.g. "Level", "Category"). Leave empty to auto-pick a string column.',
        displayOptions: {
          show: { emitHtml: [true] },
        },
      },
      {
        displayName: 'Table Row Limit',
        name: 'tableLimit',
        type: 'number',
        default: 200,
        typeOptions: { minValue: 1, maxValue: 5000 },
        description: 'Max rows rendered into the HTML table',
        displayOptions: {
          show: { emitHtml: [true] },
        },
      },
      {
        displayName: 'Report Title',
        name: 'reportTitle',
        type: 'string',
        default: 'BIM X – Watch Preview',
        displayOptions: {
          show: { emitHtml: [true] },
        },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const total = items.length;

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
    const groupBy = (this.getNodeParameter('groupBy', 0) as string || '').trim();
    const tableLimit = this.getNodeParameter('tableLimit', 0) as number;
    const reportTitle = this.getNodeParameter('reportTitle', 0) as string;

    const n = Math.min(sampleSize, total);

    // sampling
    let indices: number[] = [];
    if (sampleMode === 'firstN') {
      indices = [...Array(n).keys()];
    } else if (sampleMode === 'lastN') {
      indices = Array.from({ length: n }, (_, i) => total - n + i);
    } else {
      const set = new Set<number>();
      while (set.size < n) set.add(Math.floor(Math.random() * total));
      indices = Array.from(set.values());
    }

    // preview rows (truncate)
    const previewRows = indices.map((i) => {
      const data = { ...(items[i].json || {}) };
      for (const k of Object.keys(data)) {
        const v = (data as any)[k];
        if (typeof v === 'string' && v.length > maxStringLen) {
          (data as any)[k] = v.slice(0, maxStringLen) + '…';
        }
      }
      return data;
    });

    // schema + fill stats
    const schema: Record<
      string,
      { types: Record<string, number>; nulls: number; uniques: number; filled: number }
    > = {};
    const allKeys = new Set<string>();
    for (const it of items) Object.keys(it.json || {}).forEach((k) => allKeys.add(k));

    if (includeSchema && total > 0) {
      for (const k of allKeys) {
        const typesCount: Record<string, number> = {};
        const seen = new Set<string>();
        let nulls = 0;
        let filled = 0;
        for (const it of items) {
          const v = (it.json as any)[k];
          if (isNullish(v) || v === '') {
            nulls++;
            continue;
          }
          filled++;
          const t = inferTypesFlag ? inferType(v) : typeof v;
          typesCount[t] = (typesCount[t] || 0) + 1;
          if (['string', 'number', 'boolean'].includes(typeof v)) seen.add(String(v));
        }
        schema[k] = { types: typesCount, nulls, uniques: seen.size, filled };
      }
    }

    // group counts (for chart)
    let groupKey = groupBy;
    if (!groupKey) {
      // auto-pick: first string-ish field seen in sampled rows
      const first = previewRows[0] || {};
      const tryKey =
        Object.keys(first).find((k) => typeof (first as any)[k] === 'string') ||
        Array.from(allKeys)[0];
      groupKey = tryKey || '';
    }

    const groupCounts: Record<string, number> = {};
    if (groupKey) {
      for (const it of items) {
        const raw = (it.json as any)[groupKey];
        const label =
          isNullish(raw) || raw === '' ? '(empty)' : String(raw).slice(0, 80);
        groupCounts[label] = (groupCounts[label] || 0) + 1;
      }
      // Top 20 + Others
      const sorted = Object.entries(groupCounts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 20) {
        const top = sorted.slice(0, 20);
        const restSum = sorted.slice(20).reduce((s, [, v]) => s + v, 0);
        top.push(['(others)', restSum]);
        for (const k of Object.keys(groupCounts)) delete groupCounts[k];
        for (const [k, v] of top) groupCounts[k] = v;
      }
    }

    // meta JSON item for output2
    const meta: any = {
      totalItems: total,
      sampleMode,
      sampleSize: n,
      preview: previewRows,
      schemaKeys: Array.from(allKeys),
      schema: includeSchema ? schema : undefined,
      groupBy: groupKey || undefined,
      groupCounts: groupKey ? groupCounts : undefined,
      generatedAt: new Date().toISOString(),
    };

    const metaItem: INodeExecutionData = { json: { watch: meta } };

    // optional HTML
    if (emitHtml) {
      // columns for table
      const cols = Array.from(allKeys);
      const limitedRows = items.slice(0, Math.min(tableLimit, items.length)).map((it) => it.json || {});

      // fill percentages
      const fillPairs = Object.entries(schema).map(([k, v]) => [
        k,
        total > 0 ? Math.round((100 * (v?.filled || 0)) / total) : 0,
      ]) as Array<[string, number]>;
      fillPairs.sort((a, b) => b[1] - a[1]);
      const topFill = fillPairs.slice(0, 30); // keep charts readable

      const html = buildHtml({
        title: reportTitle || 'BIM X – Watch Preview',
        total,
        colCount: cols.length,
        tableHeaders: cols,
        tableRows: limitedRows,
        groupKey: groupKey || '',
        groupCounts,
        fillRates: topFill, // [name, pct]
        generatedAt: new Date().toLocaleString('de-DE'),
      });

      const bin = await this.helpers.prepareBinaryData(Buffer.from(html, 'utf8'));
      bin.fileName = 'bimx_watch_preview.html';
      bin.mimeType = 'text/html';

      // anhängen an metaItem
      metaItem.binary = { html: bin };
    }

    const output1 = outputMetaOnly ? [] : items;
    const output2 = [metaItem];
    return [output1, output2];
  }
}

/** HTML-Report (leichtgewichtig, ohne Kosten-Teil, angelehnt an deinen Stil) */
function buildHtml(opts: {
  title: string;
  total: number;
  colCount: number;
  tableHeaders: string[];
  tableRows: Array<Record<string, any>>;
  groupKey: string;
  groupCounts: Record<string, number>;
  fillRates: Array<[string, number]>;
  generatedAt: string;
}) {
  const {
    title,
    total,
    colCount,
    tableHeaders,
    tableRows,
    groupKey,
    groupCounts,
    fillRates,
    generatedAt,
  } = opts;

  const headersHtml = tableHeaders
    .map((h) => `<th>${esc(h)}</th>`)
    .join('');

  const rowsHtml = tableRows
    .map((row) => {
      const tds = tableHeaders
        .map((h) => `<td>${esc((row as any)[h])}</td>`)
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  // charts data
  const groupLabels = Object.keys(groupCounts || {});
  const groupValues = groupLabels.map((k) => groupCounts[k]);

  const fillLabels = fillRates.map(([k]) => k);
  const fillValues = fillRates.map(([, v]) => v);

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
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
      <h1>${esc(title)}</h1>
      <p>Quick preview generated ${esc(generatedAt)}</p>
    </div>

    <div class="summary">
      <div class="kpi">
        <h3>Items</h3>
        <div class="value">${total.toLocaleString('de-DE')}</div>
      </div>
      <div class="kpi">
        <h3>Columns</h3>
        <div class="value">${colCount.toLocaleString('de-DE')}</div>
      </div>
      ${
        groupKey
          ? `<div class="kpi"><h3>Group by</h3><div class="value" style="font-size:1.1rem">${esc(
              groupKey,
            )}</div></div>`
          : ''
      }
    </div>

    <div class="section">
      <h2>Charts</h2>
      <div class="charts">
        <div class="chart-card">
          <h3>${groupKey ? `Counts by “${esc(groupKey)}”` : 'Counts'}</h3>
          <canvas id="chartGroup"></canvas>
        </div>
        <div class="chart-card">
          <h3>Fill rate by column [%]</h3>
          <canvas id="chartFill"></canvas>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Table Preview (${tableRows.length.toLocaleString('de-DE')} rows)</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>${headersHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    // Data from Node
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
        const c0=stops[i0].match(/[0-9a-f]{2}/gi).map(h=>parseInt(h,16));
        const c1=stops[Math.min(i0+1,seg)].match(/[0-9a-f]{2}/gi).map(h=>parseInt(h,16));
        const r=Math.round(c0[0]+(c1[0]-c0[0])*f);
        const g=Math.round(c0[1]+(c1[1]-c0[1])*f);
        const b=Math.round(c0[2]+(c1[2]-c0[2])*f);
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
}
