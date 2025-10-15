// src/nodes/BimxBcsvBuilder.node.ts
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

type InRule = {
  title: string;
  guids: string[];
  color?: string;      // 'red' | '#RRGGBB' | '255,0,0' etc.
  field?: string;
  operator?: string;
  pattern?: string;
};

function parseColorToRGB(c?: string): { r: number; g: number; b: number } {
  if (!c) return { r: 255, g: 0, b: 0 };
  const lower = c.toLowerCase();
  const named: Record<string, [number, number, number]> = {
    red: [255, 0, 0], yellow: [255, 193, 7], orange: [255, 145, 0],
    green: [34, 197, 94], blue: [59, 130, 246], purple: [139, 92, 246],
  };
  if (named[lower]) {
    const [r, g, b] = named[lower];
    return { r, g, b };
  }
  const csv = c.match(/^(\d{1,3}),\s*(\d{1,3}),\s*(\d{1,3})$/);
  if (csv) return { r: +csv[1], g: +csv[2], b: +csv[3] };
  const hex = c.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { r, g, b };
  }
  return { r: 255, g: 0, b: 0 };
}

export class BimxBcsvBuilder implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – SmartViews Builder',
    name: 'bimxBcsvBuilder',
    group: ['transform'],
    version: 1,
    icon: 'file:BIMX.svg',
    description: 'Erzeugt BIMcollab SmartViews (.bcsv) aus Rule-Validator-Ergebnissen',
    defaults: { name: 'BIM X – SmartViews Builder' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source (Rule Results)',
        name: 'sourceMode',
        type: 'options',
        default: 'prev',
        options: [
          { name: 'From previous node JSON (rules array)', value: 'prev' },
        ],
      },
      {
        displayName: 'Set Title',
        name: 'setTitle',
        type: 'string',
        default: 'BIM X – Validation Set',
        description: 'Titel des SmartView-Sets',
      },
      { displayName: 'Creator', name: 'creator', type: 'string', default: 'BIM X' },
      { displayName: 'Version', name: 'version', type: 'string', default: '1.0' },
      { displayName: 'Respect Rule Colors', name: 'respectColors', type: 'boolean', default: true },
      { displayName: 'Isolate Elements', name: 'isolate', type: 'boolean', default: true },
      { displayName: 'Include Timestamp', name: 'withTs', type: 'boolean', default: true },
      { displayName: 'File Name', name: 'fileName', type: 'string', default: 'smartviews.bcsv' },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    if (!items.length) return [items];

    const setTitle = this.getNodeParameter('setTitle', 0) as string;
    const creator  = this.getNodeParameter('creator', 0) as string;
    const version  = this.getNodeParameter('version', 0) as string;
    const respectColors = this.getNodeParameter('respectColors', 0) as boolean;
    const isolate  = this.getNodeParameter('isolate', 0) as boolean;
    const withTs   = this.getNodeParameter('withTs', 0) as boolean;
    const fileName = this.getNodeParameter('fileName', 0) as string;

    // ---- Eingabe erkennen: rules[] ODER perRule[]
    let rules: InRule[] | undefined;
    const src = items[0]?.json ?? {};
    if (Array.isArray((src as any).rules)) {
      rules = (src as any).rules as InRule[];
    } else if (Array.isArray((src as any).perRule)) {
      rules = ((src as any).perRule as any[]).map((r, idx): InRule => ({
        title: r.title ?? `Rule ${idx + 1}`,
        guids: Array.isArray(r.guids) ? r.guids : [],
        color: r.color,
        field: r.field,
        operator: r.operator,
        pattern: r.pattern,
      }));
    }

    if (!rules || !rules.length) {
      throw new NodeOperationError(this.getNode(), 'Expected item[0].json.rules (oder perRule) array from Rule Validator.');
    }

    const now = new Date().toISOString();

    // ---- BCSV (XML) zusammenbauen
    const xmlEsc = (s: string) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<SMARTVIEWSET>');
    parts.push(`  <TITLE>${xmlEsc(setTitle)}</TITLE>`);
    parts.push(`  <CREATOR>${xmlEsc(creator)}</CREATOR>`);
    parts.push(`  <VERSION>${xmlEsc(version)}</VERSION>`);
    if (withTs) parts.push(`  <TIMESTAMP>${xmlEsc(now)}</TIMESTAMP>`);
    parts.push('  <SMARTVIEWS>');

    for (const rule of rules) {
      const name = rule.title || 'Rule';
      const { r, g, b } = respectColors ? parseColorToRGB(rule.color) : { r: 255, g: 0, b: 0 };

      parts.push('    <SMARTVIEW>');
      parts.push(`      <NAME>${xmlEsc(name)}</NAME>`);
      parts.push(`      <ISOLATE>${isolate ? 'true' : 'false'}</ISOLATE>`);
      parts.push('      <RULES>');

      // wir nutzen GUID-Einzelregeln, damit SmartViews die Elemente exakt treffen
      for (const guid of (rule.guids || [])) {
        parts.push('        <RULE>');
        parts.push('          <IFCTYPE>Any</IFCTYPE>');
        parts.push('          <PROPERTY>');
        parts.push('            <NAME>GUID</NAME>');
        parts.push('            <PROPERTYSETNAME>Summary</PROPERTYSETNAME>');
        parts.push('            <TYPE>Summary</TYPE>');
        parts.push('            <VALUETYPE>StringValue</VALUETYPE>');
        parts.push('            <UNIT>None</UNIT>');
        parts.push('          </PROPERTY>');
        parts.push('          <CONDITION>');
        parts.push('            <TYPE>Is</TYPE>');
        parts.push(`            <VALUE>${xmlEsc(guid)}</VALUE>`);
        parts.push('          </CONDITION>');
        parts.push('          <ACTION>');
        parts.push('            <TYPE>AddSetColored</TYPE>');
        parts.push(`            <R>${r}</R><G>${g}</G><B>${b}</B>`);
        parts.push('          </ACTION>');
        parts.push('        </RULE>');
      }

      parts.push('      </RULES>');
      parts.push('    </SMARTVIEW>');
    }

    parts.push('  </SMARTVIEWS>');
    parts.push('</SMARTVIEWSET>');

    const xml = parts.join('\n');
    const bin = await this.helpers.prepareBinaryData(Buffer.from(xml, 'utf8'));
    bin.fileName = fileName;
    bin.mimeType = 'application/xml';

    return [[{ json: { count: rules.length, setTitle, creator, version }, binary: { bcsv: bin } }]];
  }
}
