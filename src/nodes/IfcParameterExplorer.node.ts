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

type OutputMode = 'items' | 'flat' | 'grouped';
type ValueStyle = 'full' | 'leaf';

export class IfcParameterExplorer implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'BIM X – IFC Parameter Explorer',
    name: 'ifcParameterExplorer',
    icon: 'file:BIMX.svg',
    group: ['transform'],
    version: 1,
    description:
      'Listet Parameter aus IfcSpace (Space.*, Pset_*, Qto_*); wahlweise als Liste oder als ein zusammengefasstes Objekt für Drag&Drop.',
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
      {
        displayName: 'Output',
        name: 'outputMode',
        type: 'options',
        default: 'grouped',
        options: [
          { name: 'Items (one per key)', value: 'items' },
          { name: 'Single Object (flat)', value: 'flat' },
          { name: 'Single Object (grouped by set)', value: 'grouped' },
        ],
        description:
          '„Single Object“ erzeugt genau ein Item, das beim Aufklappen direkt alle Parameter als Felder zeigt.',
      },
      {
        displayName: 'Value Style',
        name: 'valueStyle',
        type: 'options',
        default: 'full',
        options: [
          { name: 'Full key (recommended)', value: 'full' },
          { name: 'Leaf only', value: 'leaf' },
        ],
        description:
          'Welcher String als Feldwert geschrieben wird. „Full key“ ist ideal zum Drag&Drop in den QTO-Node.',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      const binName = this.getNodeParameter('binaryPropertyName', i) as string;
      const maxExamples = this.getNodeParameter('maxExamples', i) as number;
      const outputMode = this.getNodeParameter('outputMode', i) as OutputMode;
      const valueStyle = this.getNodeParameter('valueStyle', i) as ValueStyle;

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
        type Entry = {
          fullName: string; // z. B. "Pset_SpaceCommon.WallCovering"
          setName: string;  // z. B. "Pset_SpaceCommon" | "Space" | "Qto_*"
          prop: string;     // Leaf, z. B. "WallCovering"
          sample: any | null;
          kind: 'space' | 'pset' | 'qto';
        };
        const entries: Entry[] = [];

        const toPrim = (v: any) => {
          let x = v;
          while (x && typeof x === 'object' && 'value' in x && Object.keys(x).length === 1) x = x.value;
          if (x && typeof x === 'object' && 'value' in x && typeof x.value !== 'object') x = x.value;
          return x;
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
            if (val == null) continue;
            entries.push({
              fullName: `Space.${attr}`,
              setName: 'Space',
              prop: attr,
              sample: val,
              kind: 'space',
            });
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
                if (!nm) continue;
                entries.push({
                  fullName: `${setName}.${nm}`,
                  setName,
                  prop: nm,
                  sample: val ?? null,
                  kind: 'pset',
                });
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
                if (!nm) continue;
                entries.push({
                  fullName: `${qName}.${nm}`,
                  setName: qName,
                  prop: nm,
                  sample: val,
                  kind: 'qto',
                });
              }
            }
          }
        }

        // --- Ausgabe gemäß Modus ---
        if (outputMode === 'items') {
          // Einzel-Items (bestehend): name/prop/label/group/type/sample
          for (const e of entries) {
            out.push({
              json: {
                name: e.fullName,
                prop: e.prop,
                label: e.prop,
                group: e.setName,
                type: e.kind,
                sample: e.sample,
              },
            });
          }
        } else if (outputMode === 'flat') {
          // Ein Item, flach: Key = Leaf, Value = leaf|full (erste Vorkommen gewinnt)
          const flat: Record<string, any> = {};
          for (const e of entries) {
            if (flat[e.prop] !== undefined) continue; // erste Definition behalten
            flat[e.prop] = (valueStyle === 'full') ? e.fullName : e.prop;
          }
          out.push({ json: flat });
        } else {
          // grouped: Ein Item, gruppiert: { Space: {Name:"..."}, Pset_*: {...}, Qto_*: {...} }
          const grouped: Record<string, Record<string, any>> = {};
          for (const e of entries) {
            if (!grouped[e.setName]) grouped[e.setName] = {};
            const target = grouped[e.setName];
            if (target[e.prop] !== undefined) continue; // erste Definition behalten
            target[e.prop] = (valueStyle === 'full') ? e.fullName : e.prop;
          }
          out.push({ json: grouped as any });
        }
      } finally {
        try { api.CloseModel(modelID); } catch {}
      }
    }

    return [out];
  }
}
