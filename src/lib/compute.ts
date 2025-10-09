// src/lib/compute.ts

import {
  IfcAPI,
  // Entity constants:
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
} from 'web-ifc';

import { footprintAreaXY, meshVolume } from './mesh-math';

// ---------------- Types / Options ----------------
export interface QtoOptions {
  allParams?: boolean;
  useGeometry?: boolean;   // Wenn Area/Volume aus Pset fehlen → Geometrie versuchen
  forceGeometry?: boolean; // Immer Geometrie rechnen (überschreibt Pset-Ergebnisse)
  extraParams?: string[];  // Zusätzliche Parameternamen
  renameMap?: Record<string, string>;
  round?: number;
}

// --------------- Helpers -------------------------

function num(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v?.value ?? v);
  return Number.isFinite(n) ? n : undefined;
}

function str(v: any): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v?.value === 'string') return v.value;
  return String(v);
}

function setIf<T extends object, K extends keyof T>(obj: T, key: K, maybe: any) {
  if (maybe !== undefined && maybe !== null && maybe !== '') (obj as any)[key] = maybe;
}

type AnyLine = any;

function isArray(x: any): x is any[] {
  return Array.isArray(x);
}

// Pset/Quantity Traversal – defensiv
function collectPropsAndQuantities(
  api: IfcAPI,
  modelID: number,
  spaceExpressID: number,
) {
  const props: Record<string, any> = {};
  let areaFromQto: number | undefined;
  let volFromQto: number | undefined;

  // Alle RelDefinesByProperties einmal sammeln
  const relIDs = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES) as any;
  for (const rid of relIDs as Iterable<number>) {
    const rel: AnyLine = api.GetLine(modelID, rid);
    const related = rel?.RelatedObjects;
    if (!isArray(related)) continue;
    if (!related.some((o: any) => o?.value === spaceExpressID)) continue;

    const def = rel?.RelatingPropertyDefinition;
    const defId = def?.value;
    if (!defId) continue;

    const pd: AnyLine = api.GetLine(modelID, defId);

    // IFCPROPERTYSET → SingleValues
    if (pd?.type === IFCPROPERTYSET && isArray(pd.HasProperties)) {
      for (const hp of pd.HasProperties) {
        const prop: AnyLine = api.GetLine(modelID, hp.value);
        if (prop?.type !== IFCPROPERTYSINGLEVALUE) continue;
        const pname = str(prop?.Name) ?? '';
        const nval = prop?.NominalValue;
        const sval =
          nval?.value ??
          nval?.wrappedValue ?? // manche Exporte
          nval;
        if (pname) props[pname] = sval;
      }
    }

    // IFCELEMENTQUANTITY → Area/Volume
    if (pd?.type === IFCELEMENTQUANTITY && isArray(pd.Quantities)) {
      for (const q of pd.Quantities) {
        const ql: AnyLine = api.GetLine(modelID, q.value);
        if (ql?.type === IFCQUANTITYAREA) {
          areaFromQto = areaFromQto ?? num(ql.AreaValue);
        } else if (ql?.type === IFCQUANTITYVOLUME) {
          volFromQto = volFromQto ?? num(ql.VolumeValue);
        }
      }
    }
  }

  // Häufige Pset-Namen auf Area/Volume mappen (z.B. Pset_SpaceCommon)
  const fallbackArea =
    num(props['NetFloorArea']) ??
    num(props['GrossFloorArea']) ??
    num(props['Area']);
  const fallbackVol =
    num(props['NetVolume']) ??
    num(props['GrossVolume']) ??
    num(props['Volume']);

  return {
    props,
    area: areaFromQto ?? fallbackArea,
    volume: volFromQto ?? fallbackVol,
  };
}

// Geometrie der ShapeItems eines Products triangulieren
function computeGeometryForSpace(
  api: IfcAPI,
  modelID: number,
  space: AnyLine,
): { areaXY?: number; volume?: number } {
  try {
    const rep = space?.Representation;
    const reps = rep?.Representations;
    if (!isArray(reps)) return {};

    let totalVol = 0;
    let totalAreaXY = 0;

    for (const r of reps) {
      const line = api.GetLine(modelID, r.value);
      const items = line?.Items;
      if (!isArray(items)) continue;

      for (const it of items) {
        const geomID = it?.value;
        if (!geomID) continue;

        // Low-level Zugriff wie in web-ifc-three: GetGeometry + Arrays
        const geom: any = (api as any).GetGeometry?.(modelID, geomID);
        if (!geom) continue;

        const ia: Uint32Array =
          (api as any).GetIndexArray?.(geom.GetIndexData(), geom.GetIndexDataSize()) ??
          new Uint32Array();
        const va: Float32Array =
          (api as any).GetVertexArray?.(geom.GetVertexData(), geom.GetVertexDataSize()) ??
          new Float32Array();

        if (ia.length >= 3 && va.length >= 9) {
          totalVol += meshVolume(va, ia);
          totalAreaXY += footprintAreaXY(va, ia);
        }

        // Speicher frei geben (wie üblich bei web-ifc)
        (api as any).ReleaseGeometry?.(geom);
      }
    }

    return {
      areaXY: totalAreaXY || undefined,
      volume: totalVol || undefined,
    };
  } catch {
    // still, no crash
    return {};
  }
}

// Numerische Rundung anwenden
function roundAll(obj: Record<string, any>, digits = 8) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] =
      typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(digits)) : v;
  }
  return out;
}

// ---------------- Main ---------------------------

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const api = new IfcAPI();
  await api.Init();

  // Wichtig: KEIN SetWasmPath in Node
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const rows: Array<Record<string, any>> = [];

    // Alle IfcSpaces
    const spaceIDs = api.GetLineIDsWithType(modelID, IFCSPACE) as any;

    for (const id of spaceIDs as Iterable<number>) {
      const sp: AnyLine = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: str(sp?.GlobalId) ?? '',
        Name: str(sp?.Name) ?? '',
        LongName: str(sp?.LongName) ?? '',
      };

      // Psets / Quantities einsammeln
      const { props, area, volume } = collectPropsAndQuantities(api, modelID, id);

      // Extra / All Parameter
      if (opts.allParams) {
        for (const [k, v] of Object.entries(props)) setIf(row, k, v);
      } else if (opts.extraParams?.length) {
        for (const key of opts.extraParams) {
          if (key in props) setIf(row, key, props[key]);
        }
      }

      // Area/Volume übernehmen (sofern nicht "forceGeometry")
      if (!opts.forceGeometry) {
        if (area !== undefined) row.Area = area;
        if (volume !== undefined) row.Volume = volume;
      }

      // Geometrie-Fallback (wenn gewünscht oder erzwungen oder Werte fehlen)
      const needGeom =
        opts.forceGeometry ||
        (opts.useGeometry && (row.Area == null || row.Volume == null));

      if (needGeom) {
        const g = computeGeometryForSpace(api, modelID, sp);
        if (g.areaXY != null) row.Area = g.areaXY;
        if (g.volume != null) row.Volume = g.volume;
      }

      // Rename anwenden
      if (opts.renameMap && Object.keys(opts.renameMap).length) {
        for (const [oldKey, newKey] of Object.entries(opts.renameMap)) {
          if (oldKey in row) {
            row[newKey] = row[oldKey];
            if (newKey !== oldKey) delete row[oldKey];
          }
        }
      }

      // Rundung (nur Ausgabe, interne Berechnungen bleiben double)
      const rounded = roundAll(row, opts.round ?? 8);
      rows.push(rounded);
    }

    return rows;
  } finally {
    api.CloseModel(modelID);
    // api.Dispose(); // gibt es in web-ifc nicht
  }
}
