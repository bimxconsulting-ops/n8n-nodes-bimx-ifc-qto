// src/lib/compute.ts

import {
  IfcAPI,
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

import { footprintAreaXY, meshVolume } from './mesh-math';

export interface QtoOptions {
  /** Alle PropertySets + ElementQuantities flach in die Zeile übernehmen */
  allParams?: boolean;
  /** Falls Area/Volume nicht aus Quantities gelesen werden konnten, Geometrie-Fallback versuchen */
  useGeometry?: boolean;
  /** Geometrie **erzwingen** (auch wenn bereits QTO vorhanden ist) */
  forceGeometry?: boolean;
  /** Zusätzliche Feldnamen vom IfcSpace (oder Pset), die explizit gelesen werden sollen */
  extraParams?: string[];
  /** { "AltName": "NeuName" } */
  renameMap?: Record<string, string>;
  /** Dezimalrundung (wird im Node zusätzlich nochmal angewandt) */
  round?: number;
}

/* ---------------------------- Helper ---------------------------- */

function val(v: any) {
  // web-ifc liefert häufig { value, type } – wir holen defensiv den Wert
  if (v == null) return v;
  if (typeof v === 'object' && 'value' in v) return (v as any).value;
  return v;
}

function toNumberOrNull(v: any): number | null {
  const n = Number(val(v));
  return Number.isFinite(n) ? n : null;
}

function roundIfNeeded(n: number | null | undefined, round?: number) {
  if (n == null) return n as any;
  if (typeof round === 'number') return Number(n.toFixed(round));
  return n;
}

/** Alle (Name, Wert) aus einem IfcPropertySet (nur SingleValue) */
function readPsetEntries(api: any, modelID: number, psetLine: any) {
  const out: Record<string, any> = {};
  const psetName = val(psetLine?.Name) ?? 'Pset';
  const props = psetLine?.HasProperties;
  if (Array.isArray(props)) {
    for (const p of props) {
      const pl = api.GetLine(modelID, p?.value);
      if (!pl) continue;
      if (pl?.type === IFCPROPERTYSINGLEVALUE) {
        const name = val(pl?.Name) ?? '';
        const nominal = val(pl?.NominalValue);
        out[`${psetName}.${name}`] = nominal;
      } else {
        const name = val(pl?.Name) ?? '';
        out[`${psetName}.${name}`] = val(pl?.NominalValue ?? pl?.Value ?? pl);
      }
    }
  }
  return out;
}

/** Aus einem IfcElementQuantity Area/Volume herausziehen */
function readElementQuantities(api: any, modelID: number, qtoLine: any) {
  const out: { Area?: number; Volume?: number } = {};
  const quants = qtoLine?.Quantities;
  if (Array.isArray(quants)) {
    for (const q of quants) {
      const ql = api.GetLine(modelID, q?.value);
      if (!ql) continue;
      if (ql.type === IFCQUANTITYAREA) {
        const a = toNumberOrNull(ql.AreaValue);
        if (a != null) out.Area = a;
      } else if (ql.type === IFCQUANTITYVOLUME) {
        const v = toNumberOrNull(ql.VolumeValue);
        if (v != null) out.Volume = v;
      }
    }
  }
  return out;
}

/** Alle RelDefinesByProperties suchen, die sich auf ein Produkt beziehen */
function collectAllRelDefines(api: any, modelID: number, productId: number) {
  const out: number[] = [];
  const ids = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (const rid of ids as Iterable<number>) {
    const rel = api.GetLine(modelID, rid);
    const related = rel?.RelatedObjects;
    if (!Array.isArray(related)) continue;
    if (related.some((o: any) => o?.value === productId)) {
      out.push(rid);
    }
  }
  return out;
}

/** Für einen Space: alle Psets + ElementQuantities in ein flaches Objekt lesen */
function collectAllParamsForSpace(api: any, modelID: number, spaceId: number) {
  const flat: Record<string, any> = {};
  const rels = collectAllRelDefines(api, modelID, spaceId);

  for (const rid of rels) {
    const rel = api.GetLine(modelID, rid);
    const defRef = rel?.RelatingPropertyDefinition;
    if (!defRef?.value) continue;
    const def = api.GetLine(modelID, defRef.value);

    if (def?.type === IFCPROPERTYSET) {
      Object.assign(flat, readPsetEntries(api, modelID, def));
    } else if (def?.type === IFCELEMENTQUANTITY) {
      const q = readElementQuantities(api, modelID, def);
      if (q.Area != null) flat['Qto.Area'] = q.Area;
      if (q.Volume != null) flat['Qto.Volume'] = q.Volume;
    }
  }

  return flat;
}

/** Geometrie (XY-„Footprint“-Fläche und 3D-Volumen) für einen Space via web-ifc streamen */
function computeGeometryForSpace(api: any, modelID: number, spaceId: number) {
  let areaXY: number | undefined;
  let volume: number | undefined;

  // web-ifc API Node: StreamAllMeshes(modelID, callback, includeIndices?)
  // Wir greifen „any“-basiert zu, damit TS-Änderungen in web-ifc keine Builds brechen.
  const stream = (api as any).StreamAllMeshes?.bind(api);
  const getGeometry = (api as any).GetGeometry?.bind(api);
  const getVerts = (api as any).GetVertexData?.bind(api);
  const getIndex = (api as any).GetIndexData?.bind(api);

  if (!stream || !getGeometry || !getVerts || !getIndex) {
    return { Area: areaXY, Volume: volume }; // keine Geometrie verfügbar
  }

  stream(modelID, (mesh: any) => {
    if (mesh.expressID !== spaceId) return;

    // mesh.geometry ist ein „ID“/Handle – über GetGeometry holen wir die Buffers
    const geom = getGeometry(modelID, mesh.geometry);
    if (!geom) return;

    const vertArr = getVerts(geom.GetVertexData?.());
    const idxArr = getIndex(geom.GetIndexData?.());
    if (!(vertArr instanceof Float32Array) || !(idxArr instanceof Uint32Array)) return;

    // 2D-„Footprint“-Fläche (XY-Projektion) + Volumen
    const a = footprintAreaXY(vertArr, idxArr);
    const v = meshVolume(vertArr, idxArr);

    // Falls mehrere Meshes pro Space: aufsummieren
    areaXY = (areaXY ?? 0) + a;
    volume = (volume ?? 0) + v;
  }, true);

  return {
    Area: areaXY,
    Volume: volume,
  };
}

/* ---------------------------- Hauptfunktion ---------------------------- */

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const api = new IfcAPI();
  await api.Init();

  // Wichtig: Uint8Array übergeben (kein ArrayBuffer)
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const rows: Array<Record<string, any>> = [];

    // Alle IfcSpaces
    const spaces = api.GetLineIDsWithType(modelID, IFCSPACE);

    for (const sid of spaces as Iterable<number>) {
      const space = api.GetLine(modelID, sid);

      // Grunddaten
      const row: Record<string, any> = {
        GlobalId: val(space?.GlobalId),
        Name: val(space?.Name),
        LongName: val(space?.LongName),
      };

      // Alle PropertySets / Quantities einsammeln (für „All Parameters“ und/oder QTO)
      const flat = collectAllParamsForSpace(api as any, modelID, sid);

      // QTO zuerst aus Quantities (falls vorhanden)
      let area = toNumberOrNull(flat['Qto.Area']);
      let volume = toNumberOrNull(flat['Qto.Volume']);

      // Geometrie-Fallback?
      const needGeom =
        !!opts.forceGeometry ||
        (!!opts.useGeometry && (area == null || volume == null));

      if (needGeom) {
        const g = computeGeometryForSpace(api as any, modelID, sid);
        if (g.Area != null) area = g.Area;
        if (g.Volume != null) volume = g.Volume;
      }

      // Auf Zeile schreiben (optional rund)
      row['Area'] = roundIfNeeded(area ?? null, opts.round);
      row['Volume'] = roundIfNeeded(volume ?? null, opts.round);

      // Extra Parameters: erst direkt am Entity, sonst aus „flat“
      if (Array.isArray(opts.extraParams)) {
        for (const key of opts.extraParams) {
          if (!key) continue;
          const direct = val((space as any)?.[key]);
          if (direct != null) {
            row[key] = direct;
            continue;
          }
          if (flat[key] != null) row[key] = val(flat[key]);
          // alternativ: Pset-Keys durchsuchen, die auf denselben Namen enden
        }
      }

      // All Parameters: komplette Sammlung aus Psets + QTO anhängen
      if (opts.allParams) {
        for (const [k, v] of Object.entries(flat)) {
          // Area/Volume aus QTO heißen oben „Area/Volume“ – duplikate vermeiden:
          if (k === 'Qto.Area' || k === 'Qto.Volume') continue;
          row[k] = v;
        }
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

      rows.push(row);
    }

    return rows;
  } finally {
    // In web-ifc@0.0.5x gibt es in Node meist nur CloseModel:
    api.CloseModel(modelID);
    // KEIN api.Dispose() in dieser Version
  }
}
