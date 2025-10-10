// src/lib/compute.ts

import {
  IfcAPI,
  // Entity/type constants:
  IFCSPACE,
  IFCPROJECT,
  IFCBUILDINGSTOREY,
  IFCPROPERTYSET,
  IFCELEMENTQUANTITY,
  IFCRELAGGREGATES,
  IFCRELDEFINESBYPROPERTIES,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

import { footprintAreaXY, meshVolume } from './mesh-math';

export interface QtoOptions {
  allParams?: boolean;
  useGeometry?: boolean;   // Fallback: nutze Mesh-Geometrie, wenn QTO fehlt
  forceGeometry?: boolean; // Erzwinge Mesh-Geometrie (überschreibt QTO)
  extraParams?: string[];  // zusätzliche Einzel-Parameter (falls du bestimmte willst)
  renameMap?: Record<string, string>;
  round?: number;          // Rundung findet im Node statt; hier optional
}

// ------------------------------------------------------------
// Helper
// ------------------------------------------------------------

const asArray = <T = any>(v: any): T[] => (Array.isArray(v) ? v : v ? [v] : []);

function getNum(v: any): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function setIfNum(target: Record<string, any>, key: string, v: any) {
  const n = getNum(v);
  if (typeof n === 'number') target[key] = n;
}

// Bevorzugte Höhen-Propertynamen, falls vorhanden:
const HEIGHT_KEYS = [
  'NetHeight', 'UnboundedHeight', 'BoundedHeight', 'Height', 'RoomHeight',
  'GrossHeight', 'IfcSpaceHeight', 'LimitOffset', 'BaseOffset'
];

// ------------------------------------------------------------
// Parsing aller relevanten Relationen einmal vorab
// ------------------------------------------------------------

function indexRelAggregates(api: IfcAPI, modelID: number) {
  const byChild = new Map<number, number>(); // childId -> parentId
  const relIds = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  for (const rid of relIds as any as number[]) {
    const rel: any = api.GetLine(modelID, rid);
    const parent = rel?.RelatingObject?.value;
    const related = asArray(rel?.RelatedObjects);
    for (const ro of related) {
      const child = ro?.value;
      if (parent && child) byChild.set(child, parent);
    }
  }
  return byChild;
}

function indexRelDefinesByProps(api: IfcAPI, modelID: number) {
  // spaceId -> { psets: [IfcPropertySet], quants: [IfcElementQuantity] }
  const map = new Map<number, { psets: number[]; quants: number[] }>();

  const relIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (const rid of relIds as any as number[]) {
    const rel: any = api.GetLine(modelID, rid);
    const related = asArray(rel?.RelatedObjects);
    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId) continue;
    const def: any = api.GetLine(modelID, defId);

    let kind: 'pset' | 'quant' | null = null;
    if (def?.type === IFCPROPERTYSET) kind = 'pset';
    else if (def?.type === IFCELEMENTQUANTITY) kind = 'quant';

    if (!kind) continue;

    for (const ro of related) {
      const sid = ro?.value;
      if (!sid) continue;
      const entry = map.get(sid) ?? { psets: [], quants: [] };
      if (kind === 'pset') entry.psets.push(defId);
      else entry.quants.push(defId);
      map.set(sid, entry);
    }
  }
  return map;
}

function getProjectName(api: IfcAPI, modelID: number): string | undefined {
  const ids = api.GetLineIDsWithType(modelID, IFCPROJECT);
  for (const id of ids as any as number[]) {
    const p: any = api.GetLine(modelID, id);
    const n = p?.Name?.value ?? p?.LongName?.value;
    if (n) return String(n);
  }
  return undefined;
}

function ascendToStoreyAndProject(
  api: IfcAPI,
  modelID: number,
  byChild: Map<number, number>,
  spaceId: number
) {
  // steige über RelAggregates hoch, bis Storey/Project gefunden
  let cur: number | undefined = byChild.get(spaceId);
  let storeyName: string | undefined;
  let storeyElevation: number | undefined;

  while (cur) {
    const line: any = api.GetLine(modelID, cur);
    if (line?.type === IFCBUILDINGSTOREY) {
      storeyName = line?.Name?.value ?? storeyName;
      storeyElevation = getNum(line?.Elevation) ?? storeyElevation;
      break;
    }
    cur = byChild.get(cur);
  }
  return { storeyName, storeyElevation };
}

// Alle Properties (Psets + ElementQuantities) in ein flaches Objekt schreiben
function collectAllParameters(
  api: IfcAPI,
  modelID: number,
  entry: { psets: number[]; quants: number[] },
  out: Record<string, any>,
) {
  // PropertySets
  for (const pid of entry.psets) {
    const pset: any = api.GetLine(modelID, pid);
    const psetName = String(pset?.Name?.value ?? 'PropertySet');
    const props = asArray(pset?.HasProperties);
    for (const p of props) {
      const pline: any = api.GetLine(modelID, p.value);
      const key = `${psetName}.${String(pline?.Name?.value ?? '')}`;
      // SingleValue:
      const val = pline?.NominalValue?.value ?? pline?.NominalValue ?? pline?.EnumerationValues ?? pline?.Value;
      if (val !== undefined && val !== null) {
        out[key] = typeof val === 'object' && 'value' in val ? (val as any).value : val;
      }
    }
  }

  // ElementQuantities
  for (const qid of entry.quants) {
    const qset: any = api.GetLine(modelID, qid);
    const qName = String(qset?.Name?.value ?? 'ElementQuantity');
    for (const q of asArray(qset?.Quantities)) {
      const qline: any = api.GetLine(modelID, q.value);
      const baseKey = `${qName}.${String(qline?.Name?.value ?? '')}`;
      if (qline?.type === IFCQUANTITYAREA) {
        setIfNum(out, baseKey || 'Area', qline?.AreaValue);
      } else if (qline?.type === IFCQUANTITYVOLUME) {
        setIfNum(out, baseKey || 'Volume', qline?.VolumeValue);
      } else {
        // andere Quantity-Typen
        const candidates = qline?.[Object.keys(qline).find(k => /Value$/i.test(k)) || ''] as any;
        const n = getNum(candidates);
        if (n !== undefined) out[baseKey] = n;
      }
    }
  }
}

// Eine sinnvolle Raumhöhe aus allen Parametern ziehen
function guessHeight(params: Record<string, any>): number | undefined {
  // 1) gezielt nach bekannten Keys
  for (const k of HEIGHT_KEYS) {
    const val = params[k] ?? params[`Pset_SpaceCommon.${k}`] ?? params[`SpaceCommon.${k}`];
    const n = getNum(val);
    if (n !== undefined) return n;
  }
  // 2) fallback: erstes Vorkommen eines Keys mit "height"
  for (const [k, v] of Object.entries(params)) {
    if (/height/i.test(k)) {
      const n = getNum(v);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

// ------------------------------------------------------------
// Geometrie-Streaming (web-ifc) → Mesh-Area/Volume je Space
// ------------------------------------------------------------

function computeGeometryQtoForSpaces(
  api: IfcAPI,
  modelID: number,
  spaceIds: Set<number>
) {
  // expressID -> aggregierte {area, volume}
  const acc = new Map<number, { area: number; volume: number }>();

  try {
    api.StreamAllMeshes(modelID, (mesh: any) => {
      // Nur Spaces summieren
      const id = mesh.expressID as number;
      if (!spaceIds.has(id)) return;

      const geom = api.GetGeometry(modelID, mesh.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx   = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

      // In Node kommen Float32Array/Uint32Array zurück; falls nicht, konvertieren
      const v = (verts instanceof Float32Array) ? verts : new Float32Array(verts as any);
      const i = (idx   instanceof Uint32Array)  ? idx   : new Uint32Array(idx as any);

      const area = footprintAreaXY(v, i);
      const volume = meshVolume(v, i);

      const cur = acc.get(id) ?? { area: 0, volume: 0 };
      cur.area += area;
      cur.volume += volume;
      acc.set(id, cur);
    });
  } catch {
    // Geometrie kann bei manchen IFCs/WASM-Builds scheitern – dann still schweigen
  }

  return acc;
}

// ------------------------------------------------------------
// Hauptfunktion
// ------------------------------------------------------------

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const api = new IfcAPI();
  await api.Init();

  // Unbedingt Uint8Array übergeben
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const spaceIdsArr = api.GetLineIDsWithType(modelID, IFCSPACE) as any as number[];
    const spaceIds = new Set<number>(spaceIdsArr);

    const relAgg = indexRelAggregates(api, modelID);
    const relDefs = indexRelDefinesByProps(api, modelID);
    const projectName = getProjectName(api, modelID);

    // Geometrie vorberechnen (nur falls gebraucht)
    const geomAcc = (opts.useGeometry || opts.forceGeometry)
      ? computeGeometryQtoForSpaces(api, modelID, spaceIds)
      : new Map<number, { area: number; volume: number }>();

    const rows: Array<Record<string, any>> = [];

    for (const id of spaceIds) {
      const sp: any = api.GetLine(modelID, id);
      const base: Record<string, any> = {
        GlobalId: sp?.GlobalId?.value ?? '',
        Name: sp?.Name?.value ?? '',
        LongName: sp?.LongName?.value ?? '',
      };

      if (projectName) base.Project = projectName;

      // Storey + Elevation
      const { storeyName, storeyElevation } = ascendToStoreyAndProject(api, modelID, relAgg, id);
      if (storeyName)  base.Storey = storeyName;
      if (storeyElevation !== undefined) base.StoreyElevation = storeyElevation;

      // Alle Psets/Quantities einsammeln (für All Parameters ODER um gezielte Werte zu finden)
      const params: Record<string, any> = {};
      const defs = relDefs.get(id);
      if (defs) {
        collectAllParameters(api, modelID, defs, params);
      }

      // Quantity-basiertes Area/Volume (falls vorhanden)
      let areaFromQto = getNum(
        params['Pset_SpaceCommon.GrossArea'] ??
        params['Pset_SpaceCommon.NetArea'] ??
        params['Area'] ??
        params['ElementQuantity.Area'] // falls so benannt
      );
      // Falls Quantities mit Name.* geschrieben sind, picke generisch:
      if (areaFromQto === undefined) {
        for (const [k, v] of Object.entries(params)) {
          if (/\.?Area$/i.test(k)) {
            const n = getNum(v);
            if (n !== undefined) { areaFromQto = n; break; }
          }
        }
      }

      let volumeFromQto = getNum(
        params['Pset_SpaceCommon.GrossVolume'] ??
        params['Pset_SpaceCommon.NetVolume'] ??
        params['Volume'] ??
        params['ElementQuantity.Volume']
      );
      if (volumeFromQto === undefined) {
        for (const [k, v] of Object.entries(params)) {
          if (/\.?Volume$/i.test(k)) {
            const n = getNum(v);
            if (n !== undefined) { volumeFromQto = n; break; }
          }
        }
      }

      // Geometrie
      const g = geomAcc.get(id);
      const areaFromGeom = g?.area;
      const volumeFromGeom = g?.volume;

      // Auswahl je Option
      if (opts.forceGeometry) {
        if (areaFromGeom !== undefined) base.Area = areaFromGeom;
        if (volumeFromGeom !== undefined) base.Volume = volumeFromGeom;
      } else if (opts.useGeometry) {
        base.Area   = areaFromQto   ?? areaFromGeom;
        base.Volume = volumeFromQto ?? volumeFromGeom;
      } else {
        base.Area   = areaFromQto;
        base.Volume = volumeFromQto;
      }

      // TopElevation (StoreyElevation + erkannte Raumhöhe)
      const h = guessHeight(params);
      if (h !== undefined && storeyElevation !== undefined) {
        base.TopElevation = storeyElevation + h;
      }

      // Extra-Parameter explizit hinzufügen
      if (opts.extraParams?.length) {
        for (const p of opts.extraParams) {
          if (p && params[p] !== undefined) base[p] = params[p];
        }
      }

      // All Parameters → alles mit raus schreiben
      if (opts.allParams) {
        for (const [k, v] of Object.entries(params)) {
          if (!(k in base)) base[k] = v;
        }
      }

      // Rename anwenden
      if (opts.renameMap) {
        for (const [oldKey, newKey] of Object.entries(opts.renameMap)) {
          if (oldKey in base) {
            base[newKey] = base[oldKey];
            if (newKey !== oldKey) delete base[oldKey];
          }
        }
      }

      rows.push(base);
    }

    return rows;
  } finally {
    api.CloseModel(modelID);
    // Kein api.Dispose() – existiert im aktuellen Typ nicht zuverlässig
  }
}
