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

// <- von nodes/ eine Ebene hoch zu utils/
import { toBuffer } from '../utils/toBuffer';


export class IfcParameterExplorer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'IFC Parameter Explorer',
    name: 'ifcParameterExplorer',
    group: ['transform'],
    version: 1,
    description: 'Listet alle Parameter-Schlüssel aus IfcSpace (Space.*, Pset_*, Qto_*)',
    defaults: { name: 'IFC Parameter Explorer' },
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

      const buf = toBuffer(binary.data, binary.fileType || 'application/octet-stream');

      const api = new IfcAPI();
      await api.Init();
      const modelID = api.OpenModel(new Uint8Array(buf));

      try {
        // 1) RelDefines Index
        const byRelated = new Map<number, any[]>();
        const relVec = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
        const size = relVec.size ? relVec.size() : 0;
        for (let k = 0; k < size; k++) {
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

        // 2) Sammeln
        const keys = new Map<string, any[]>(); // name -> samples[]
        const spaceVec = api.GetLineIDsWithType(modelID, IFCSPACE);
        const n = spaceVec.size ? spaceVec.size() : 0;

        const toPrim = (v: any) => {
          let x = v;
          while (x && typeof x === 'object' && 'value' in x && Object.keys(x).length === 1) x = x.value;
          if (x && typeof x === 'object' && 'value' in x && typeof x.value !== 'object') x = x.value;
          return x;
        };

        const pushKey = (name: string, sample: any) => {
          if (!keys.has(name)) keys.set(name, []);
          const arr = keys.get(name)!;
          if (arr.length < maxExamples && sample !== undefined) arr.push(sample);
        };

        for (let k = 0; k < n; k++) {
          const id = spaceVec.get(k);
          const sp = api.GetLine(modelID, id);

          // Space.* (ein paar sinnvolle Felder, erweitere bei Bedarf)
          ['Name','LongName','ObjectType','Description','Tag','Number','ElevationWithFlooring'].forEach(attr => {
            const val = toPrim(sp?.[attr]);
            if (val != null) pushKey(`Space.${attr}`, val);
          });

          const defs = byRelated.get(id) ?? [];
          for (const def of defs) {
            if (def?.type === IFCPROPERTYSET) {
              const setName = toPrim(def?.Name) ?? 'Pset';
              for (const p of def?.HasProperties ?? []) {
                const pid = p?.value; if (!pid) continue;
                const pl = api.GetLine(modelID, pid);
                const nm = toPrim(pl?.Name);
                const val = toPrim(pl?.NominalValue ?? pl?.NominalValue?.value ?? pl?.value);
                if (nm) pushKey(`${setName}.${nm}`, val);
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
                if (nm) pushKey(`${qName}.${nm}`, val);
              }
            }
          }
        }

        // 3) Ausgabe: ein Item pro Key
        for (const [name, samples] of keys) {
          out.push({ json: { name, sample: samples?.[0] ?? null, type: name.startsWith('Space.') ? 'space' : (name.startsWith('Qto_') ? 'qto' : 'pset') } });
        }

      } finally {
        try { api.CloseModel(modelID); } catch {}
      }
    }

    return [out];
  }
}
