// src/nodes/BimxIfcAttributeExport.node.ts
import type { IExecuteFunctions, INodeType, INodeTypeDescription, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import * as XLSX from 'xlsx';
import { IfcAPI } from 'web-ifc';
import { toBuffer } from '../utils/toBuffer';
import { extractAllForElement, toPrimitive } from '../lib/extract';

export class BimxIfcAttributeExport implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – IFC Attribute Export',
    name: 'bimxIfcAttributeExport',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description: 'Exports all attributes/Psets/Qto from IFC as wide or long table (XLSX/JSON)',
    defaults: { name: 'BIM X – IFC Attribute Export' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      { displayName: 'Binary Property', name: 'binaryProperty', type: 'string', default: 'data' },
      {
        displayName: 'Entity Scope',
        name: 'scope',
        type: 'options',
        options: [
          { name: 'IfcSpace only', value: 'spaces' },
          { name: 'Custom IFC types', value: 'custom' },
        ],
        default: 'spaces',
      },
      {
        displayName: 'Custom IFC Types',
        name: 'customTypes',
        type: 'string',
        default: 'IFCSPACE,IFCWALL,IFCDOOR',
        description: 'Comma-separated IFC type names, e.g. IFCSPACE,IFCWALLSTANDARDCASE',
        displayOptions: { show: { scope: ['custom'] } },
      },
      {
        displayName: 'Row Layout',
        name: 'layout',
        type: 'options',
        options: [
          { name: 'Wide (one row per element)', value: 'wide' },
          { name: 'Long (one row per key/value)', value: 'long' },
        ],
        default: 'wide',
      },
      { displayName: 'Include Core Attributes (Name, Description, Tag)', name: 'includeCore', type: 'boolean', default: true },
      { displayName: 'Generate XLSX', name: 'xlsx', type: 'boolean', default: true },
      { displayName: 'Generate JSON', name: 'jsonOut', type: 'boolean', default: true },
    ],
  };

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const binProp = this.getNodeParameter('binaryProperty', i) as string;
      const scope = this.getNodeParameter('scope', i) as 'spaces'|'custom';
      const customTypes = (this.getNodeParameter('customTypes', i) as string) ?? '';
      const layout = this.getNodeParameter('layout', i) as 'wide'|'long';
      const includeCore = this.getNodeParameter('includeCore', i) as boolean;
      const wantXlsx = this.getNodeParameter('xlsx', i) as boolean;
      const wantJson = this.getNodeParameter('jsonOut', i) as boolean;

      const bin = items[i].binary?.[binProp];
      if (!bin?.data) {
        throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" missing`, { itemIndex: i });
      }
      const buffer = toBuffer(bin.data);

      const api = new IfcAPI();
      await api.Init();
      const modelID = api.OpenModel(new Uint8Array(buffer));

      try {
        const typeNames: string[] =
          scope === 'spaces'
            ? ['IFCSPACE']
            : customTypes.split(',').map(s => s.trim()).filter(Boolean);

        const allRows: any[] = [];

        for (const tn of typeNames) {
          const typeConst = (require('web-ifc') as any)[tn];
          if (typeof typeConst !== 'number') continue;
          const vec = api.GetLineIDsWithType(modelID, typeConst);
          const size = typeof vec?.size === 'function' ? vec.size() : 0;

          for (let k = 0; k < size; k++) {
            const id = vec.get(k);
            const rows = extractAllForElement(api as any, modelID, id, includeCore, layout);
            allRows.push(...rows);
          }
        }

        const newItem: INodeExecutionData = { json: {}, binary: {} };

        if (wantJson) {
          newItem.json = { rows: allRows, layout };
        }

        if (wantXlsx) {
          const ws = XLSX.utils.json_to_sheet(allRows);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, 'Attributes');
          const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;

          const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
          xbin.fileName = 'ifc_attributes.xlsx';
          xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
          newItem.binary!['xlsx'] = xbin;
        }

        out.push(newItem);
      } finally {
        try { api.CloseModel(modelID); } catch {}
      }
    }

    return this.prepareOutputData(out);
  }
}
