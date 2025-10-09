// src/lib/compute.ts

import {
  IfcAPI,
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

import { getSpaceAreaVolume } from './mesh-math';

/* ------------------------------- Optionen --------------------------------- */
export interface QtoOptions {
  allParams?: boolean;          // alle Properties / Psets flatten
  useGeometry?: boolean;        // falls Area/Volume fehlen → Geometrie verwenden
  forceGeometry?: boolean;      // immer Geometrie nutzen (überschreibt Pset)
  extraParams?: string[];       // zusätzliche Felder, die wir versuchen herauszuziehen
  renameMap?: Record<string, string>; // Spalten umbenennen
  round?: number;               // Rundung (wird im Node noch mal angewendet)
}

/* ------------------------------ Hilfsfunktionen ---------------------------- */

// defensives Auslesen von IFC-Property-Werten
function val(x: any): any {
  if (x == null) return x;
  if (typeof x === 'object' && 'value' in x) return (x as any).value;
  return x;
}

// flaches Objekt zusammenführen (A ← B), ohne Prototypen
// (Cast auf Record<string, any>, um TS2862 zu vermeiden)
function assignFlat<A extends object, B extends object>(a: A, b: B): A & B {
  const target = a as unknown as Record<string, any>;
  const source = b as unknown as Record<string, any>;
  for (const [k, v] of Object.entries(source)) {
    target[k] = v;
  }
  return a as A & B;
}

// (einfaches) Flatten eines IFC-Lines-Objekts zu Key→Value
function flattenIfcObject(o: any, out: Record<string, any>, prefix = '') {
  if (!o || typeof o !== 'object') return;

  for (const [k, v] of Object.entries(o)) {
    if (k === 'type' || k === 'expressID') continue;

    const key = prefix ? `${prefix}.${k}` : k;

    if (v && typeof v === 'object') {
      if ('value' in (v as any) && typeof (v as any).value !== 'object') {
        out[key] = (v as any).value;
      } else if (Array.isArray(v)) {
        out[key] = v.map((it: any) => val(it));
      } else {
        flattenIfcObject(v, out, key);
      }
    } else {
      out[key] = v;
    }
  }
}

/* ------------------------------ Pset/QTO-Scan ------------------------------ */

function readQtoAreaVolumeFromPsets(
  api: IfcAPI,
  modelID: number,
  spaceId: number
): { area?: number; volume?: number } {
  let area: number | undefined;
  let volume: number | undefined;

  const relIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  const it = relIds[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    const rid = r.value as number;
    const rel: any = api.GetLine(modelID, rid);
    const related = Array.isArray(rel?.RelatedObjects) ? rel.RelatedObjects : [];
    if (!related.some((o: any) => o?.value === spaceId)) continue;

    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId) continue;

    const def: any = api.GetLine(modelID, defId);
    if (def?.type !== IFCELEMENTQUANTITY || !Array.isArray(def?.Quantities)) continue;

    for (const q of def.Quantities) {
      const qline: any = api.GetLine(modelID, q?.value);
      if (!qline) continue;

      if (qline.type === IFCQUANTITYAREA && area === undefined) {
        const v = qline.AreaValue;
        if (typeof v === 'number') area = v;
      } else if (qline.type === IFCQUANTITYVOLUME && volume === undefined) {
        const v = qline.VolumeValue;
        if (typeof v === 'number') volume = v;
      }
    }
  }

  return { area, volume };
}

function collectAllParamsForSpace(
  api: IfcAPI,
  modelID: number,
  spaceLine: any
): Record<string, any> {
  const out: Record<string, any> = {};
  // Basiseigenschaften des Space flachziehen
  flattenIfcObject(spaceLine, out);

  // Zugeordnete PropertySets/Quantities ebenfalls einsammeln
  const relIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  const it = relIds[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    const rid = r.value as number;
    const rel: any = api.GetLine(modelID, rid);
    const related = Array.isArray(rel?.RelatedObjects) ? rel.RelatedObjects : [];
    if (!related.some((o: any) => o?.value === spaceLine?.expressID)) continue;

    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId) continue;

    const def: any = api.GetLine(modelID, defId);
    const tmp: Record<string, any> = {};
    flattenIfcObject(def, tmp);

    assignFlat(out, tmp);
  }

  return out;
}

/* --------------------------------- Runner ---------------------------------- */

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const {
    allParams = false,
    useGeometry = false,
    forceGeometry = false,
    extraParams = [],
    renameMap = {},
  } = opts;

  const api = new IfcAPI();

  // In Node NICHT SetWasmPath setzen. web-ifc lädt web-ifc-node.wasm selbst.
  await api.Init();

  // WICHTIG: Uint8Array übergeben
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const spaceIds = api.GetLineIDsWithType(modelID, IFCSPACE);
    const rows: Array<Record<string, any>> = [];

    const it = spaceIds[Symbol.iterator]();
    for (let s = it.next(); !s.done; s = it.next()) {
      const id = s.value as number;
      const space: any = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: val(space?.GlobalId),
        Name: val(space?.Name),
        LongName: val(space?.LongName),
      };

      // Pset/QTO zuerst
      const q = readQtoAreaVolumeFromPsets(api, modelID, id);
      if (q.area !== undefined) row.Area = q.area;
      if (q.volume !== undefined) row.Volume = q.volume;

      // alle Parameter?
      if (allParams) {
        const all = collectAllParamsForSpace(api, modelID, space);
        assignFlat(row, all);
        row.GlobalId = val(space?.GlobalId);
        row.Name = val(space?.Name);
        row.LongName = val(space?.LongName);
      }

      // extra Parameter?
      for (const p of extraParams) {
        if (!p) continue;
        if (row[p] !== undefined) continue;
        const tmp: Record<string, any> = {};
        flattenIfcObject(space, tmp);
        if (tmp[p] !== undefined) row[p] = tmp[p];
      }

      // Geometrie (Footprint/Volumen)
      if (forceGeometry || (useGeometry && (row.Area === undefined || row.Volume === undefined))) {
        const gv = getSpaceAreaVolume(api as any, modelID, id);
        if (forceGeometry || row.Area === undefined) {
          if (gv.area !== undefined) row.Area = gv.area;
        }
        if (forceGeometry || row.Volume === undefined) {
          if (gv.volume !== undefined) row.Volume = gv.volume;
        }
      }

      // Rename
      for (const [oldKey, newKey] of Object.entries(renameMap)) {
        if (oldKey in row) {
          row[newKey] = row[oldKey];
          if (newKey !== oldKey) delete row[oldKey];
        }
      }

      rows.push(row);
    }

    return rows;
  } finally {
    // Modell schließen – KEIN api.Dispose() im Node-API!
    api.CloseModel(modelID);
  }
}
