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
  return `${h().slice(0, 8)}-${s()}-${s()}-${s()}-${h()}${s()}`.toLowerCase();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sp(n: number) { return ' '.repeat(n * 4); } // 4-space indent
const NL = '\r\n';

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
          { name: 'Auto-detect (rules or perRule)', value: 'auto' },
          { name: 'From previous node JSON (rules array)', value: 'rules' },
          { name: 'From previous node JSON (perRule array)', value: 'perRule' },
        ],
      },
      {
        displayName: 'Set Title',
        name: 'setTitle',
        type: 'string',
        default: 'Validation Report',
        description: 'Used as <TITLE> of SMARTVIEWSET',
      },
      {
        displayName: 'Creator (email)',
        name: 'creator',
        type: 'string',
        default: 'info@bim-x-consulting.de', // wie von dir gewünscht
      },
      {
        displayName: 'Include Timestamp',
        name: 'withTimestamp',
        type: 'boolean',
        default: true,
      },
      {
        displayName: 'Respect Rule Colors (if provided)',
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

    const sourceOpt = this.getNodeParameter('source', 0) as 'auto' | 'rules' | 'perRule';
    const setTitle = this.getNodeParameter('setTitle', 0) as string;
    const creator  = this.getNodeParameter('creator', 0) as string;
    const withTs   = this.getNodeParameter('withTimestamp', 0) as boolean;
    const respect  = this.getNodeParameter('respectRuleColors', 0) as boolean;
    const defCol   = (this.getNodeParameter('defaultColor', 0) as any) || {};
    const defR = Number(defCol.r ?? 255), defG = Number(defCol.g ?? 0), defB = Number(defCol.b ?? 0);
    const fileName = this.getNodeParameter('fileName', 0) as string;

    const nowIso = new Date().toISOString().slice(0, 19); // yyyy-mm-ddTHH:MM:SS

    // ---- Input normalisieren
    const root = items[0]?.json ?? {};
    const hasRules   = Array.isArray((root as any).rules);
    const hasPerRule = Array.isArray((root as any).perRule);
    const source = sourceOpt === 'auto' ? (hasRules ? 'rules' : (hasPerRule ? 'perRule' : 'rules')) : sourceOpt;

    let rules: SimpleRule[] = [];
    if (source === 'rules') {
      if (!hasRules) throw new NodeOperationError(this.getNode(), 'Expected item[0].json.rules array.');
      for (const r of (root as any).rules as any[]) {
        const title = String(r.title ?? r.name ?? 'Rule');
        const guids = Array.isArray(r.guids) ? r.guids.map(String) : [];
        const color = r.color && typeof r.color === 'object'
          ? { r: Number(r.color.r ?? defR), g: Number(r.color.g ?? defG), b: Number(r.color.b ?? defB) }
          : undefined;
        rules.push({ title, guids, color });
      }
    } else {
      if (!hasPerRule) throw new NodeOperationError(this.getNode(), 'Expected item[0].json.perRule array.');
      for (const r of (root as any).perRule as any[]) {
        const title = String(r.title ?? r.name ?? 'Rule');
        const guids = Array.isArray(r.guids) ? r.guids.map(String) : [];
        rules.push({ title, guids });
      }
    }

    // GUIDs deduplizieren/aufräumen, leere entfernen, nur Regeln mit Treffern ausgeben
    rules = rules.map(r => ({
      ...r,
      guids: Array.from(new Set((r.guids || []).map(g => g.trim()).filter(Boolean))),
    })).filter(r => r.guids.length > 0);

    if (!rules.length) throw new NodeOperationError(this.getNode(), 'No GUIDs found.');

    // ---- Header exakt wie im BIMcollab-Beispiel
    const header =
      `<?xml version="1.0"?>${NL}` +
      `<bimcollabsmartviewfile>${NL}` +
      `${sp(1)}<version>8</version>${NL}` +
      `${sp(1)}<applicationversion>Win - Version: 9.6 (build 9.6.6.0)</applicationversion>${NL}` +
      `</bimcollabsmartviewfile>${NL}${NL}`;

    // ---- SMARTVIEWSET aufbauen
    const setGuid = uuidLike();
    let xml = header;
    xml += `<SMARTVIEWSETS>${NL}`;
    xml += `${sp(1)}<SMARTVIEWSET>${NL}`;
    xml += `${sp(2)}<TITLE>${esc(setTitle)}</TITLE>${NL}`;
    xml += `${sp(2)}<DESCRIPTION></DESCRIPTION>${NL}`;
    xml += `${sp(2)}<GUID>${setGuid}</GUID>${NL}`;
    xml += `${sp(2)}<MODIFICATIONDATE>${withTs ? nowIso : ''}</MODIFICATIONDATE>${NL}`;
    xml += `${sp(2)}<SMARTVIEWS>${NL}`;

    // ---- pro Regel genau 1 SMARTVIEW
    for (const r of rules) {
      const vGuid = uuidLike();
      const col = respect && r.color ? r.color : { r: defR, g: defG, b: defB };

      xml += `${sp(3)}<SMARTVIEW>${NL}`;
      xml += `${sp(4)}<TITLE>${esc(r.title)}</TITLE>${NL}`;
      xml += `${sp(4)}<DESCRIPTION></DESCRIPTION>${NL}`;
      xml += `${sp(4)}<CREATOR>${esc(creator)}</CREATOR>${NL}`;
      xml += `${sp(4)}<CREATIONDATE>${withTs ? nowIso : ''}</CREATIONDATE>${NL}`;
      xml += `${sp(4)}<MODIFIER>${esc(creator)}</MODIFIER>${NL}`;
      xml += `${sp(4)}<MODIFICATIONDATE>${withTs ? nowIso : ''}</MODIFICATIONDATE>${NL}`;
      xml += `${sp(4)}<GUID>${vGuid}</GUID>${NL}`;
      // keine <GROUPS> – entspricht deinem Beispiel

      xml += `${sp(4)}<RULES>${NL}`;
      for (const guid of r.guids) {
        xml += `${sp(5)}<RULE>${NL}`;
        xml += `${sp(6)}<IFCTYPE>Any</IFCTYPE>${NL}`;
        xml += `${sp(6)}<PROPERTY>${NL}`;
        xml += `${sp(7)}<NAME>GUID</NAME>${NL}`;
        xml += `${sp(7)}<PROPERTYSETNAME>Summary</PROPERTYSETNAME>${NL}`;
        xml += `${sp(7)}<TYPE>Summary</TYPE>${NL}`;
        xml += `${sp(7)}<VALUETYPE>StringValue</VALUETYPE>${NL}`;
        xml += `${sp(7)}<UNIT>None</UNIT>${NL}`;
        xml += `${sp(6)}</PROPERTY>${NL}`;
        xml += `${sp(6)}<CONDITION>${NL}`;
        xml += `${sp(7)}<TYPE>Is</TYPE>${NL}`;
        xml += `${sp(7)}<VALUE>${esc(guid)}</VALUE>${NL}`;
        xml += `${sp(6)}</CONDITION>${NL}`;
        xml += `${sp(6)}<ACTION>${NL}`;
        xml += `${sp(7)}<TYPE>AddSetColored</TYPE>${NL}`;
        xml += `${sp(7)}<R>${col.r}</R>${NL}`;
        xml += `${sp(7)}<G>${col.g}</G>${NL}`;
        xml += `${sp(7)}<B>${col.b}</B>${NL}`;
        xml += `${sp(7)}<A>255</A>${NL}`; // Alpha wie im Beispiel
        xml += `${sp(6)}</ACTION>${NL}`;
        xml += `${sp(5)}</RULE>${NL}`;
      }
      xml += `${sp(4)}</RULES>${NL}`;

      // Pflichtblöcke wie im Beispiel
      xml += `${sp(4)}<INFORMATIONTAKEOFF>${NL}`;
      xml += `${sp(5)}<PROPERTYSETNAME>None</PROPERTYSETNAME>${NL}`;
      xml += `${sp(5)}<PROPERTYNAME>None</PROPERTYNAME>${NL}`;
      xml += `${sp(5)}<OPERATION>0</OPERATION>${NL}`;
      xml += `${sp(4)}</INFORMATIONTAKEOFF>${NL}`;
      xml += `${sp(4)}<EXPLODEMODE>KeepParentsAndChildren</EXPLODEMODE>${NL}`;

      xml += `${sp(3)}</SMARTVIEW>${NL}`;
    }

    xml += `${sp(2)}</SMARTVIEWS>${NL}`;
    xml += `${sp(1)}</SMARTVIEWSET>${NL}`;
    xml += `</SMARTVIEWSETS>${NL}`;

    // ---- Binary ausgeben
    const bin = await this.helpers.prepareBinaryData(Buffer.from(xml, 'utf8'));
    bin.fileName = fileName;
    bin.fileExtension = 'bcsv';
    bin.mimeType = 'text/xml';

    const out: INodeExecutionData = {
      json: {
        setTitle,
        views: rules.length,
        totalGuids: rules.reduce((s, r) => s + r.guids.length, 0),
      },
      binary: { bcsv: bin },
    };

    return [[out]];
  }
}
