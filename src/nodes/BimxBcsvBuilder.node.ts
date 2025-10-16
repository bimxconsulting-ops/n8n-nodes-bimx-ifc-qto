// src/nodes/BimxBcsvBuilder.node.ts
import type { IExecuteFunctions, INodeExecutionData, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

type SimpleRule = {
  title: string;
  guids: string[];
  color?: { r: number; g: number; b: number };
};

function uuidLike(): string {
  const h = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const s = () => Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  // RFC-ähnlich, reicht für BIMcollab
  return `${h().slice(0,8)}-${s()}-${s()}-${s()}-${h()}${s()}`.toLowerCase();
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pickColor(rule: SimpleRule | undefined, respect: boolean, defR: number, defG: number, defB: number) {
  if (respect && rule?.color) return rule.color;
  return { r: defR, g: defG, b: defB };
}

export class BimxBcsvBuilder implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – SmartViews Builder',
    name: 'bimxBcsvBuilder',
    group: ['transform'],
    version: 1,
    icon: 'file:BIMX.svg',
    description: 'Builds BIMcollab SmartViews (.bcsv) from Rule Validator output (GUID lists per rule)',
    defaults: { name: 'BIM X – SmartViews Builder' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Source (Rule Results)',
        name: 'source',
        type: 'options',
        default: 'auto',
        options: [
          { name: 'From previous node JSON (rules array)', value: 'rules' },
          { name: 'From previous node JSON (perRule array)', value: 'perRule' },
          { name: 'Auto-detect (rules or perRule)', value: 'auto' },
        ],
      },
      {
        displayName: 'Set Title',
        name: 'setTitle',
        type: 'string',
        default: 'BIM X – Validation Set',
        description: 'Will be used as SMARTVIEWSET title and as group name in each SMARTVIEW',
      },
      {
        displayName: 'Creator',
        name: 'creator',
        type: 'string',
        default: 'BIM X',
      },
      {
        displayName: 'Version (info/version)',
        name: 'versionStr',
        type: 'string',
        default: '1.0',
      },
      {
        displayName: 'Respect Rule Colors',
        name: 'respectRuleColors',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Default Color',
        name: 'defaultColor',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'R', name: 'r', type: 'number', default: 255, typeOptions: { minValue: 0, maxValue: 255 } },
          { displayName: 'G', name: 'g', type: 'number', default: 0,   typeOptions: { minValue: 0, maxValue: 255 } },
          { displayName: 'B', name: 'b', type: 'number', default: 0,   typeOptions: { minValue: 0, maxValue: 255 } },
        ],
      },
      {
        displayName: 'Include Timestamp',
        name: 'withTimestamp',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'File Name',
        name: 'fileName',
        type: 'string',
        default: 'smartviews.bcsv',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    if (!items.length) return [items];

    const optSource = this.getNodeParameter('source', 0) as 'auto' | 'rules' | 'perRule';
    const setTitle = this.getNodeParameter('setTitle', 0) as string;
    const creator  = this.getNodeParameter('creator', 0) as string;
    const versionStr = this.getNodeParameter('versionStr', 0) as string;
    const respectColors = this.getNodeParameter('respectRuleColors', 0) as boolean;
    const defColor = (this.getNodeParameter('defaultColor', 0) as any) || {};
    const defR = Number(defColor.r ?? 255);
    const defG = Number(defColor.g ?? 0);
    const defB = Number(defColor.b ?? 0);
    const withTs = this.getNodeParameter('withTimestamp', 0) as boolean;
    const fileName = this.getNodeParameter('fileName', 0) as string;

    const nowIso = new Date().toISOString().slice(0,19); // yyyy-mm-ddTHH:MM:SS

    // ---- Input normalisieren (rules[] oder perRule[])
    const root = items[0]?.json ?? {};
    let rulesIn: SimpleRule[] = [];

    const hasRules   = Array.isArray((root as any).rules);
    const hasPerRule = Array.isArray((root as any).perRule);

    const source = optSource === 'auto'
      ? (hasRules ? 'rules' : (hasPerRule ? 'perRule' : 'rules'))
      : optSource;

    if (source === 'rules') {
      if (!hasRules) {
        throw new NodeOperationError(this.getNode(), 'Expected item[0].json.rules array from Rule Validator.');
      }
      for (const r of (root as any).rules as any[]) {
        const title = String(r.title ?? r.name ?? 'Rule');
        const guids = Array.isArray(r.guids) ? r.guids.map(String) : [];
        const color = r.color && typeof r.color === 'object'
          ? { r: Number(r.color.r ?? defR), g: Number(r.color.g ?? defG), b: Number(r.color.b ?? defB) }
          : undefined;
        rulesIn.push({ title, guids, color });
      }
    } else { // perRule
      if (!hasPerRule) {
        throw new NodeOperationError(this.getNode(), 'Expected item[0].json.perRule array from Rule Validator.');
      }
      for (const r of (root as any).perRule as any[]) {
        const title = String(r.title ?? r.name ?? 'Rule');
        const guids = Array.isArray(r.guids) ? r.guids.map(String) : [];
        rulesIn.push({ title, guids });
      }
    }

    // GUIDs deduplizieren + leere entfernen
    rulesIn = rulesIn.map(r => ({
      ...r,
      guids: Array.from(new Set((r.guids || []).map(g => g.trim()).filter(Boolean))),
    })).filter(r => r.guids.length > 0);

    if (!rulesIn.length) {
      throw new NodeOperationError(this.getNode(), 'No GUIDs found in rules/perRule.');
    }

    // ---- BIMcollab Header/Wrapper
    const header =
`<?xml version="1.0" encoding="UTF-8"?>
<bimcollabsmartviewfile version="8">
  <info>
    <version>${esc(versionStr)}</version>
    <application>BIM X – n8n</application>
    <date>${withTs ? nowIso : ''}</date>
  </info>
  <settings>
    <openBimMode>true</openBimMode>
  </settings>
</bimcollabsmartviewfile>
`;

    // ---- SMARTVIEWSET + SMARTVIEWS
    const setGuid = uuidLike();
    const setBlockOpen =
`<SMARTVIEWSETS>
  <SMARTVIEWSET>
    <TITLE>${esc(setTitle)}</TITLE>
    <DESCRIPTION></DESCRIPTION>
    <GUID>${setGuid}</GUID>
    <MODIFICATIONDATE>${withTs ? nowIso : ''}</MODIFICATIONDATE>
    <SMARTVIEWS>
`;

    const setBlockClose =
`    </SMARTVIEWS>
  </SMARTVIEWSET>
</SMARTVIEWSETS>
`;

    // ---- SMARTVIEWs aus Regeln
    const viewsXml = rulesIn.map((rule) => {
      const vGuid = uuidLike();
      const col = pickColor(rule, respectColors, defR, defG, defB);

      // Eine RULE pro GUID
      const rulesXml = rule.guids.map(guid => {
        return (
`        <RULE>
          <IFCTYPE>Any</IFCTYPE>
          <PROPERTY>
            <NAME>GUID</NAME>
            <PROPERTYSETNAME>Summary</PROPERTYSETNAME>
            <TYPE>Summary</TYPE>
            <VALUETYPE>StringValue</VALUETYPE>
            <UNIT>None</UNIT>
          </PROPERTY>
          <CONDITION>
            <TYPE>Is</TYPE>
            <VALUE>${esc(guid)}</VALUE>
          </CONDITION>
          <ACTION>
            <TYPE>AddSetColored</TYPE>
            <R>${col.r}</R>
            <G>${col.g}</G>
            <B>${col.b}</B>
          </ACTION>
        </RULE>`
        );
      }).join('\n');

      return (
`      <SMARTVIEW>
        <TITLE>${esc(rule.title)}</TITLE>
        <DESCRIPTION></DESCRIPTION>
        <CREATOR>${esc(creator)}</CREATOR>
        <CREATIONDATE>${withTs ? nowIso : ''}</CREATIONDATE>
        <MODIFIER>${esc(creator)}</MODIFIER>
        <MODIFICATIONDATE>${withTs ? nowIso : ''}</MODIFICATIONDATE>
        <GUID>${vGuid}</GUID>
        <GROUPS><GROUP>${esc(setTitle)}</GROUP></GROUPS>
        <RULES>
${rulesXml}
        </RULES>
      </SMARTVIEW>`
      );
    }).join('\n');

    const full = header + setBlockOpen + viewsXml + '\n' + setBlockClose;

    // ---- Binary ausgeben
    const bin = await this.helpers.prepareBinaryData(Buffer.from(full, 'utf8'));
    bin.fileName = fileName;
    bin.fileExtension = 'bcsv';
    bin.mimeType = 'text/xml';

    const out: INodeExecutionData = { json: { views: rulesIn.length, rules: rulesIn.map(r => ({ title: r.title, hits: r.guids.length })) }, binary: { bcsv: bin } };
    return [[out]];
  }
}
