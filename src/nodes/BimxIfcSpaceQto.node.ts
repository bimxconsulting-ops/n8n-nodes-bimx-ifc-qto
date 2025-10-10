// src/nodes/BimxIfcSpaceQto.node.ts
import type { IExecuteFunctions, INodeType, INodeTypeDescription } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import * as XLSX from 'xlsx';
import { runQtoOnIFC, type QtoOptions } from '../lib/compute';

interface ExtraParam { paramName: string }
interface RenameMap { parameterName: string; newName: string }

export class BimxIfcSpaceQto implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – IFC Space QTO',
    name: 'bimxIfcSpaceQto',
    icon: 'file:BIMX.svg', // wichtig: als String belassen
    group: ['transform'],
    version: 1,
    description: 'Binary IFC in → XLSX/TSV out (Area/Volume of IfcSpaces via web-ifc)',
    defaults: { name: 'BIM X – IFC Space QTO' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Binary Property',
        name: 'binaryProperty',
        type: 'string',
        default: 'data',
        description: 'Name of the binary property that contains the IFC file',
      },
      { displayName: 'Generate XLSX', name: 'xlsx', type: 'boolean', default: true },
      { displayName: 'Generate TSV (comma decimal)', name: 'tsv', type: 'boolean', default: true },
      {
        displayName: 'Round Decimals',
        name: 'round',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 10 },
        default: 8,
      },

      // ---- Options (Add options) ----
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        options: [
          { displayName: 'All Parameters', name: 'allParams', type: 'boolean', default: false },
          { displayName: 'Use Geometry Fallback', name: 'useGeometry', type: 'boolean', default: false },
          { displayName: 'Force Geometry', name: 'forceGeometry', type: 'boolean', default: false },
          {
            displayName: 'Extra Parameters',
            name: 'extraParams',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: 'param',
                displayName: 'Parameter',
                values: [
                  {
                    displayName: 'Parameter Name',
                    name: 'paramName',
                    type: 'string',
                    default: '',
                    description:
                      'Z. B. Space.Name oder Pset_SpaceCommon.WallCovering oder Qto_SpaceBaseQuantities.NetFloorArea',
                  },
                ],
              },
            ],
          },
          {
            displayName: 'Rename',
            name: 'rename',
            type: 'fixedCollection',
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: 'map',
                displayName: 'Map',
                values: [
                  { displayName: 'Parameter Name', name: 'parameterName', type: 'string', default: '' },
                  { displayName: 'New Name', name: 'newName', type: 'string', default: '' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: any[] = [];

    for (let i = 0; i < items.length; i++) {
      const binProp = this.getNodeParameter('binaryProperty', i) as string;
      const wantXlsx = this.getNodeParameter('xlsx', i) as boolean;
      const wantTsv = this.getNodeParameter('tsv', i) as boolean;
      const round = this.getNodeParameter('round', i) as number;
      const options = (this.getNodeParameter('options', i, {}) as any) ?? {};

      const bin = items[i].binary?.[binProp];
      if (!bin?.data) {
        throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" missing`, { itemIndex: i });
      }

      const buffer = Buffer.from(bin.data as string, 'base64');

      const extraParams: string[] = Array.isArray(options.extraParams?.param)
        ? (options.extraParams.param as ExtraParam[]).map(p => p.paramName).filter(Boolean)
        : [];

      const renameMap: Record<string, string> = Array.isArray(options.rename?.map)
        ? (options.rename.map as RenameMap[]).reduce((acc, m) => {
            if (m.parameterName && m.newName) acc[m.parameterName] = m.newName;
            return acc;
          }, {} as Record<string, string>)
        : {};

      const rows: Array<Record<string, any>> = await runQtoOnIFC(buffer, {
        allParams: !!options.allParams,
        useGeometry: !!options.useGeometry,
        forceGeometry: !!options.forceGeometry,
        extraParams,
        renameMap,
        round,
      } as QtoOptions);

      // Rundung auf alle numerischen Felder nochmals anwenden (UI-Konsistenz)
      const roundVal = (v: any) => (typeof v === 'number' ? Number(v.toFixed(round)) : v);
      const rowsRounded = rows.map((rw) => {
        const o: Record<string, any> = {};
        for (const [k, v] of Object.entries(rw)) o[k] = roundVal(v);
        return o;
      });

      const newItem: any = { json: { count: rowsRounded.length }, binary: {} };

      if (wantXlsx) {
        const ws = XLSX.utils.json_to_sheet(rowsRounded);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Spaces');
        const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;

        const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
        xbin.fileName = 'spaces_qto.xlsx';
        xbin.mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        newItem.binary['xlsx'] = xbin;
      }

      if (wantTsv) {
        const headers = Object.keys(rowsRounded[0] ?? {});
        const lines = [
          headers.join('\t'),
          ...rowsRounded.map(rw =>
            headers.map(h => String(rw[h] ?? '').replace('.', ',')).join('\t'),
          ),
        ];
        const tbin = await this.helpers.prepareBinaryData(Buffer.from(lines.join('\n'), 'utf8'));
        tbin.fileName = 'spaces_qto.tsv';
        tbin.mimeType = 'text/tab-separated-values';
        newItem.binary['tsv'] = tbin;
      }

      out.push(newItem);
    }

    return this.prepareOutputData(out);
  }
}
