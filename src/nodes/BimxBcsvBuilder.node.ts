// src/nodes/BimxBcsvBuilder.node.ts
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

type RuleResultIn = {
  title: string;
  ifcType?: string;
  valueType?: string;
  colorHex?: string;
  guids: string[];
};

function hexToRGB(hex?: string) {
  const h = (hex || '').replace('#','').trim();
  if (h.length !== 6) return { r: 255, g: 0, b: 0 };
  return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
}

function esc(str: string) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

export class BimxBcsvBuilder implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – BCSV SmartViews Builder',
    name: 'bimxBcsvBuilder',
    group: ['transform'],
    version: 1,
    description: 'Generate BIMcollab Smart Views (.bcsv) from Rule Validator result (GUID lists per rule).',
    defaults: { name: 'BIM X – SmartViews Builder' },
    icon: 'file:BIMX.svg',
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source (Rule Results)',
        name: 'source',
        type: 'options',
        default: 'json',
        options: [
          { name: 'From previous node JSON (rules array)', value: 'json' },
        ],
      },
      { displayName: 'Set Title', name: 'setTitle', type: 'string', default: 'BIM X – Validation Set' },
      { displayName: 'Creator', name: 'creator', type: 'string', default: 'BIM X' },
      { displayName: 'Version', name: 'version', type: 'string', default: '1.0' },
      { displayName: 'Respect Rule Colors', name: 'respectColors', type: 'boolean', default: true },
      { displayName: 'Isolate Elements', name: 'isolate', type: 'boolean', default: true, description: 'If true: mark view to isolate selection (HideNonSelected=true).' },
      { displayName: 'Include Timestamp', name: 'includeTimestamp', type: 'boolean', default: true },
      { displayName: 'File Name', name: 'fileName', type: 'string', default: 'smartviews.bcsv' },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    if (!items.length) throw new NodeOperationError(this.getNode(), 'No input items.');

    const source = this.getNodeParameter('source', 0) as 'json';
    const setTitle = this.getNodeParameter('setTitle', 0) as string;
    const creator = this.getNodeParameter('creator', 0) as string;
    const version = this.getNodeParameter('version', 0) as string;
    const respectColors = this.getNodeParameter('respectColors', 0) as boolean;
    const isolate = this.getNodeParameter('isolate', 0) as boolean;
    const includeTimestamp = this.getNodeParameter('includeTimestamp', 0) as boolean;
    const fileName = this.getNodeParameter('fileName', 0) as string;

    // Expect shape from BimxRuleValidator: item.json.rules: [{title, ifcType, valueType, colorHex, guids[]}, ...]
    let rulesIn: RuleResultIn[] = [];
    if (source === 'json') {
      const rules = (items[0].json as any)?.rules;
      if (!Array.isArray(rules)) {
        throw new NodeOperationError(this.getNode(), 'Expected item[0].json.rules array from Rule Validator.');
      }
      // filter out empty rules (no GUIDs)
      rulesIn = rules
        .map((r: any) => ({
          title: r.title || 'Rule',
          ifcType: r.ifcType || 'Any',
          valueType: r.valueType || 'StringValue',
          colorHex: r.colorHex || '#f87171',
          guids: Array.isArray(r.guids) ? r.guids.filter(Boolean) : [],
        }))
        .filter((r: RuleResultIn) => r.guids.length > 0);
    }

    if (!rulesIn.length) {
      throw new NodeOperationError(this.getNode(), 'No non-empty rule results to build SmartViews.');
    }

    const nowIso = new Date().toISOString();

    // Build XML-ish .bcsv content
    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="utf-8"?>');
    parts.push('<SMARTVIEWSET>');
    parts.push(`  <VERSION>${esc(version)}</VERSION>`);
    parts.push(`  <TITLE>${esc(setTitle)}</TITLE>`);
    if (includeTimestamp) parts.push(`  <TIMESTAMP>${esc(nowIso)}</TIMESTAMP>`);
    parts.push(`  <CREATOR>${esc(creator)}</CREATOR>`);
    parts.push('  <SMARTVIEWS>');

    rulesIn.forEach((r, idx) => {
      const title = `${r.title}`; // already human-friendly
      const { r: rr, g, b } = hexToRGB(respectColors ? r.colorHex : '#f87171');

      parts.push('    <SMARTVIEW>');
      parts.push(`      <TITLE>${esc(title)}</TITLE>`);
      parts.push('      <HIDENONSELECTED>' + (isolate ? 'true' : 'false') + '</HIDENONSELECTED>');
      parts.push('      <RULES>');

      // One RULE per GUID (mirrors your snippet)
      r.guids.forEach(guid => {
        parts.push('        <RULE>');
        parts.push(`          <IFCTYPE>${esc(r.ifcType || 'Any')}</IFCTYPE>`);
        parts.push('          <PROPERTY>');
        parts.push('            <NAME>GUID</NAME>');
        parts.push('            <PROPERTYSETNAME>Summary</PROPERTYSETNAME>');
        parts.push('            <TYPE>Summary</TYPE>');
        parts.push(`            <VALUETYPE>${esc(r.valueType || 'StringValue')}</VALUETYPE>`);
        parts.push('            <UNIT>None</UNIT>');
        parts.push('          </PROPERTY>');
        parts.push('          <CONDITION>');
        parts.push('            <TYPE>Is</TYPE>');
        parts.push(`            <VALUE>${esc(String(guid))}</VALUE>`);
        parts.push('          </CONDITION>');
        parts.push('          <ACTION>');
        parts.push('            <TYPE>AddSetColored</TYPE>');
        parts.push(`            <R>${rr}</R>`);
        parts.push(`            <G>${g}</G>`);
        parts.push(`            <B>${b}</B>`);
        parts.push('          </ACTION>');
        parts.push('        </RULE>');
      });

      parts.push('      </RULES>');
      parts.push('    </SMARTVIEW>');
    });

    parts.push('  </SMARTVIEWS>');
    parts.push('</SMARTVIEWSET>');

    const xml = parts.join('\n');
    const bin = Buffer.from(xml, 'utf8');

    const out: INodeExecutionData = {
      json: {
        setTitle,
        creator,
        version,
        isolate,
        views: rulesIn.map(r => ({ title: r.title, count: r.guids.length })),
      },
      binary: {},
    };

    const b = await this.helpers.prepareBinaryData(bin);
    b.fileName = fileName.endsWith('.bcsv') ? fileName : `${fileName}.bcsv`;
    b.mimeType = 'application/xml';
    (out.binary as any)['bcsv'] = b;

    return [[out]];
  }
}
