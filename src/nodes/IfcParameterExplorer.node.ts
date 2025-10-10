// src/nodes/IfcParameterExplorer.node.ts
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';

import {
  IfcAPI,
  IFCSPACE,
  IFCPROPERTYSET,
  IFCELEMENTQUANTITY,
  IFCRELDEFINESBYPROPERTIES,
} from 'web-ifc';

import { toBuffer } from '../utils/toBuffer';

export class IfcParameterExplorer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – IFC Parameter Explorer',
    name: 'ifcParameterExplorer',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description: 'Listet alle Parameter-Schlüssel aus IfcSpace (Space.*, Pset_*, Qto_*)',
    defaults: { name: 'BIM X – IFC Parameter Explorer' },
    inputs: ['main'],
    outputs: ['main'],
    properties: [
      {
        displayName: 'Binary Property',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        description: 'Name des Binär-Properties mit der IFC-Datei',
        required: true,
      },
      {
        displayName: 'Max Examples per Key',
        name: 'maxExamples',
        type: 'number',
        typeOptions: { minValue: 0 },
        default: 1,
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const binName = this.getNodeParameter('binaryPropertyName', i) as string;
      const maxExamples = this.getNodeParameter('maxExamples', i) as number;

      const binary = items[i].binary?.[binName];
      if (!binary?.data) {
        throw new Error(`Binary property "${binName}" nicht gefunden.`);
      }

      const buf = toBuffer(binary.data);

      const api = new IfcAPI();
      await api.Init();
      const modelID = api.OpenModel(new Uint8Array(buf));

      try {
        // --- RelDefines indexieren ---
        const byRelated = new Map<number, any[]>();
        const relVec = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
        const relSize = typeof relVec?.size === 'function' ? relVec.size() : 0;
        for (let k = 0; k < relSize; k++) {
          const relId = relVec.get(k);
          const rel = api.GetLine(modelID, relId);
          const related = rel?.RelatedObjects ?? [];
          const defId = rel?.RelatingPropertyDefinition?.value;
          if (!defId) continue;
          const def = api.GetLine(modelID, defId);
          for (const ro of related) {
            const rid = ro?.value; if (!rid) continue;
            if (!byRelated.has(rid)) byRelated.set(rid, []);
            byRelated.get(rid)!.push(def);
          }
        }

        // --- Keys sammeln ---
        type Entry = { group: string; prop: string; type: 'space' | 'pset' | 'qto'; samples: any[] };
        const keys = new Map<string, Entry>(); // fullName -> entry

        const toPrim = (v: any) => {
          let x = v;
          while (x && typeof x === 'object' && 'value' in x && Object.keys(x).length === 1) x = x.value;
          if (x && typeof x === 'object' && 'value' in x && typeof x.value !== 'object') x = x.value;
          return x;
        };

        const add = (fullName: string, group: string, prop: string, type: Entry['type'], val: any) => {
          if (!keys.has(fullName)) keys.set(fullName, { group, prop, type, samples: [] });
          const e = keys.get(fullName)!;
          if (e.samples.length < maxExamples && val !== undefined) e.samples.push(val);
        };

        const spaceVec = api.GetLineIDsWithType(modelID, IFCSPACE);
        const n = typeof spaceVec?.size === 'function' ? spaceVec.size() : 0;

        for (let k = 0; k < n; k++) {
          const id = spaceVec.get(k);
          const sp = api.GetLine(modelID, id);

          // Space.*
          const spaceAttrs = ['Name','LongName','ObjectType','Description','Tag','Number','ElevationWithFlooring'];
          for (const attr of spaceAttrs) {
            const val = toPrim(sp?.[attr as keyof typeof sp]);
            if (val != null) add(`Space.${attr}`, 'Space', attr, 'space', val);
          }

          // Pset + Qto
          const defs = byRelated.get(id) ?? [];
          for (const def of defs) {
            if (def?.type === IFCPROPERTYSET) {
              const setName = toPrim(def?.Name) ?? 'Pset';
              for (const p of def?.HasProperties ?? []) {
                const pid = p?.value; if (!pid) continue;
                const pl = api.GetLine(modelID, pid);
                const nm = toPrim(pl?.Name);
                const val = toPrim(pl?.NominalValue ?? pl?.NominalValue?.value ?? pl?.value);
                if (nm) add(`${setName}.${nm}`, setName, nm, 'pset', val);
              }
            } else if (def?.type === IFCELEMENTQUANTITY) {
              const qName = toPrim(def?.Name) ?? 'Qto';
              for (const q of def?.Quantities ?? []) {
                const qid = q?.value; if (!qid) continue;
                const ql = api.GetLine(modelID, qid);
                const nm = toPrim(ql?.Name);
                const area = toPrim(ql?.AreaValue);
                const vol  = toPrim(ql?.VolumeValue);
                const len  = toPrim(ql?.LengthValue ?? ql?.PerimeterValue);
                const val = area ?? vol ?? len ?? null;
                if (nm) add(`${qName}.${nm}`, qName, nm, 'qto', val);
              }
            }
          }
        }

        // Ausgabe: 1 Item pro Key
        for (const [fullName, e] of keys) {
          out.push({
            json: {
              // für QTO-Node:
              name: fullName,        // z.B. "Pset_SpaceCommon.WallCovering"
              prop: e.prop,          // z.B. "WallCovering"  <= nur das Leaf
              label: e.prop,         // Alias für prop
              group: e.group,        // "Space" | "Pset_SpaceCommon" | "Qto_SpaceBaseQuantities" ...
              type: e.type,          // 'space' | 'pset' | 'qto'
              sample: e.samples?.[0] ?? null,
            },
          });
        }
      } finally {
        try { api.CloseModel(modelID); } catch {}
      }
    }

    return [out];
  }
}
