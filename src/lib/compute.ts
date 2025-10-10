// src/lib/compute.ts

import {
  IfcAPI,
  // Entitäten
  IFCSPACE,
  IFCPROJECT,
  IFCBUILDINGSTOREY,
  // Relationen
  IFCRELDEFINESBYPROPERTIES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  // Property-Container
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCELEMENTQUANTITY,
  // Quantities
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

import { footprintAreaXY, meshVolume } from './mesh-math';

/* --------------------------------- Optionen -------------------------------- */

export interface QtoOptions {
  allParams?: boolean;
  useGeometry?: boolean;     // Fallback nur, wenn keine QTO-Werte gefunden
  forceGeometry?: boolean;   // Geometrie erzwingen (überschreibt QTO)
  extraParams?: string[];
  renameMap?: Record<string, string>;
  round?: number;
}

/* ------------------------------ Utility-Helper ------------------------------ */

function applyMatrix4ToVerts(vs: Float32Array, m: number[] | Float32Array) {
  if (!m || (m as any).length !== 16) return vs;
  const out = new Float32Array(vs.length);

  const m00 = +m[0],  m01 = +m[1],  m02 = +m[2],  m03 = +m[3];
  const m10 = +m[4],  m11 = +m[5],  m12 = +m[6],  m13 = +m[7];
  const m20 = +m[8],  m21 = +m[9],  m22 = +m[10], m23 = +m[11];
  const m30 = +m[12], m31 = +m[13], m32 = +m[14], m33 = +m[15];

  for (let i = 0; i < vs.length; i += 3) {
    const x = vs[i], y = vs[i + 1], z = vs[i + 2];
    out[i]     = m00 * x + m10 * y + m20 * z + m30;
    out[i + 1] = m01 * x + m11 * y + m21 * z + m31;
    out[i + 2] = m02 * x + m12 * y + m22 * z + m32;
  }
  return out;
}

function unwrapNominal(v: any): any {
  if (v == null) return v;
  if (typeof v === 'object' && 'value' in v) return (v as any).value;
  return v;
}

function setIfDefined(obj: Record<string, any>, key: string, val: any) {
  if (val !== undefined && val !== null) obj[key] = val;
}

function toUint32Any(iArr: any): Uint32Array {
  if (iArr instanceof Uint32Array) return iArr;
  // Explizit konvertieren (funktioniert auch für Uint16Array)
  const out = new Uint32Array(iArr.length ?? (iArr?.byteLength ? iArr.byteLength / 2 : 0));
  for (let i = 0; i < out.length; i++) out[i] = iArr[i] as number;
  return out;
}

/* ----------------------- Relationen/Metadaten indizieren ------------------- */

function buildRelDefinesIndex(api: any, modelID: number) {
  const map = new Map<number, number[]>();
  const ids = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  const it = ids[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    const rid = r.value as number;
    const rel = api.GetLine(modelID, rid);
    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId) continue;
    const related = rel?.RelatedObjects;
    if (!Array.isArray(related)) continue;
    for (const ro of related) {
      const eid = ro?.value;
      if (eid || eid === 0) {
        if (!map.has(eid)) map.set(eid, []);
        map.get(eid)!.push(defId);
      }
    }
  }
  return map;
}

function buildRelContainedIndex(api: any, modelID: number) {
  const map = new Map<number, number>();
  const ids = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
  const it = ids[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    const rid = r.value as number;
    const rel = api.GetLine(modelID, rid);
    const storeyId = rel?.RelatingStructure?.value;
    const elems = rel?.RelatedElements;
    if (!storeyId || !Array.isArray(elems)) continue;
    for (const e of elems) {
      const eid = e?.value;
      if (eid || eid === 0) map.set(eid, storeyId);
    }
  }
  return map;
}

function buildNameIndex(api: any, modelID: number, type: number) {
  const map = new Map<number, { Name?: string; Elevation?: number }>();
  const ids = api.GetLineIDsWithType(modelID, type);
  const it = ids[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) {
    const id = r.value as number;
    const ent = api.GetLine(modelID, id);
    const Name = unwrapNominal(ent?.Name);
    const Elevation = unwrapNominal(ent?.Elevation);
    map.set(id, { Name, Elevation });
  }
  return map;
}

function buildSpaceIdSet(api: any, modelID: number) {
  const set = new Set<number>();
  const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
  const it = ids[Symbol.iterator]();
  for (let r = it.next(); !r.done; r = it.next()) set.add(r.value as number);
  return set;
}

/* --------------- Geometrie einmal streamen + nach Space mappen ------------- */

type GeoStats = { area: number; volume: number; tris: number; minZ?: number; maxZ?: number };

function collectSpaceGeometryFast(
  api: any,
  modelID: number,
  spaceIdSet: Set<number>,
  opts: { triangleLimit?: number; firstMeshPerSpace?: boolean } = {}
) {
  const { triangleLimit = 3_000_000, firstMeshPerSpace = false } = opts;

  const perSpace = new Map<number, GeoStats>();
  let totalTris = 0;

  const consumeMesh = (fm: any) => {
    const sid = fm?.expressID ?? fm?.ExpressID;
    if (sid == null) return;
    if (!spaceIdSet.has(sid)) return;              // ✅ nur IfcSpace-Meshes
    if (firstMeshPerSpace && perSpace.has(sid)) return;

    const geom: any = api.GetGeometry(modelID, fm.geometryExpressID);
    if (!geom) return;

    const vRaw: Float32Array = api.GetArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const iRaw: any          = api.GetArray(geom.GetIndexData(),  geom.GetIndexDataSize());
    const idx: Uint32Array   = toUint32Any(iRaw);

    const tris = idx.length / 3;
    totalTris += tris;
    if (triangleLimit && totalTris > triangleLimit) return;

    let verts = vRaw;
    const m =
      (fm && (fm.matrix || fm.transformMatrix || fm.coordinationMatrix || fm.transform)) || null;
    if (m && (m as any).length === 16) verts = applyMatrix4ToVerts(verts, m as any);

    // 2D-Footprint & Volumen
    const a = footprintAreaXY(verts, idx);
    const v = meshVolume(verts, idx);

    // Z-Extents
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 2; i < verts.length; i += 3) {
      const z = verts[i];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const prev = perSpace.get(sid) ?? { area: 0, volume: 0, tris: 0 };
    prev.area   += a;
    prev.volume += v;
    prev.tris   += tris;
    prev.minZ    = Math.min(prev.minZ ?? +Infinity, minZ);
    prev.maxZ    = Math.max(prev.maxZ ?? -Infinity, maxZ);
    perSpace.set(sid, prev);

    if (typeof api.ReleaseGeometry === 'function') {
      try { api.ReleaseGeometry(modelID, fm.geometryExpressID); } catch {}
    }
  };

  if (typeof api.StreamAllMeshes === 'function') {
    try {
      // Stream All, wir filtern selbst per spaceIdSet (robuster über Versionen)
      api.StreamAllMeshes(modelID, (fm: any) => consumeMesh(fm));
    } catch {
      const fms: any = api.LoadAllGeometry(modelID);
      const size = typeof fms?.size === 'function' ? fms.size() : 0;
      for (let i = 0; i < size; i++) consumeMesh(fms.get(i));
    }
  } else {
    const fms: any = api.LoadAllGeometry(modelID);
    const size = typeof fms?.size === 'function' ? fms.size() : 0;
    for (let i = 0; i < size; i++) consumeMesh(fms.get(i));
  }

  // Aufräumen: unendliche Extents → undefined
  for (const [k, s] of perSpace) {
    if (!isFinite(s.minZ!)) s.minZ = undefined;
    if (!isFinite(s.maxZ!)) s.maxZ = undefined;
  }

  return perSpace;
}

/* ------------------------- Property-/Quantity-Lesen ------------------------ */

function collectAllParamsForSpace(
  api: any,
  modelID: number,
  spaceId: number,
  relDefinesIndex: Map<number, number[]>,
) {
  const out: Record<string, any> = {};

  const defIds = relDefinesIndex.get(spaceId) ?? [];
  for (const defId of defIds) {
    const def = api.GetLine(modelID, defId);
    if (!def) continue;

    if (def.type === IFCPROPERTYSET) {
      const psetName = unwrapNominal(def.Name) ?? `Pset_${defId}`;
      const props = def.HasProperties;
      if (Array.isArray(props)) {
        for (const p of props) {
          const pl = api.GetLine(modelID, p.value);
          if (!pl) continue;
          if (pl.type === IFCPROPERTYSINGLEVALUE) {
            const pname = unwrapNominal(pl.Name);
            const nval  = unwrapNominal(pl.NominalValue);
            if (pname) out[`${psetName}.${pname}`] = nval;
          } else {
            const pname = unwrapNominal(pl.Name) || `Prop_${p.value}`;
            const nv =
              unwrapNominal((pl as any).NominalValue) ??
              unwrapNominal((pl as any).LengthValue)  ??
              unwrapNominal((pl as any).CountValue)   ??
              unwrapNominal((pl as any).WeightValue)  ??
              unwrapNominal((pl as any).TimeValue);
            out[`${psetName}.${pname}`] = nv != null ? nv : { ...pl };
          }
        }
      }
    } else if (def.type === IFCELEMENTQUANTITY) {
      if (Array.isArray(def.Quantities)) {
        for (const q of def.Quantities) {
          const ql = api.GetLine(modelID, q.value);
          if (!ql) continue;
          const qName = unwrapNominal(ql.Name);
          if (ql.type === IFCQUANTITYAREA) {
            const val = unwrapNominal(ql.AreaValue);
            if (qName) out[qName] = val;
            setIfDefined(out, 'Area', out['Area'] ?? val);
          } else if (ql.type === IFCQUANTITYVOLUME) {
            const val = unwrapNominal(ql.VolumeValue);
            if (qName) out[qName] = val;
            setIfDefined(out, 'Volume', out['Volume'] ?? val);
          } else {
            const nv =
              unwrapNominal((ql as any).LengthValue) ??
              unwrapNominal((ql as any).CountValue)  ??
              unwrapNominal((ql as any).WeightValue) ??
              unwrapNominal((ql as any).TimeValue);
            if (qName && nv != null) out[qName] = nv;
          }
        }
      }
    } else {
      const name = unwrapNominal(def.Name) ?? `Def_${defId}`;
      out[name] = { ...def };
    }
  }

  return out;
}

/* --------------------------------- EXPORT --------------------------------- */

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const api = new IfcAPI();
  await api.Init();

  // Buffer → Uint8Array (korrekt mit Offsets)
  const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const modelID = api.OpenModel(u8);

  try {
    // Vorab-Indizes/Metadaten
    const spaceIdSet       = buildSpaceIdSet(api as any, modelID);
    const relDefinesIndex  = buildRelDefinesIndex(api as any, modelID);
    const relContainedIdx  = buildRelContainedIndex(api as any, modelID);
    const projectNames     = buildNameIndex(api as any, modelID, IFCPROJECT);
    const storeyNames      = buildNameIndex(api as any, modelID, IFCBUILDINGSTOREY);

    // Optional: Geometrie nur EINMAL streamen
    let geoBySpace: Map<number, GeoStats> | undefined;
    if (opts.useGeometry || opts.forceGeometry) {
      geoBySpace = collectSpaceGeometryFast(api as any, modelID, spaceIdSet, {
        triangleLimit: 3_000_000,
        firstMeshPerSpace: false,
      });
    }

    // Project (erstes)
    let Project: string | undefined;
    for (const [, v] of projectNames) { Project = v.Name; break; }

    // Alle Spaces iterieren
    const rows: Array<Record<string, any>> = [];
    for (const id of spaceIdSet) {
      const sp: any = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: unwrapNominal(sp?.GlobalId),
        Name:     unwrapNominal(sp?.Name),
        LongName: unwrapNominal(sp?.LongName),
      };

      if (Project) row.Project = Project;

      const storeyId = relContainedIdx.get(id);
      if (storeyId != null) {
        const s = storeyNames.get(storeyId);
        if (s?.Name) row.Storey = s.Name;
        if (s?.Elevation != null) row['Storey Elevation'] = s.Elevation;
      }

      if (opts.extraParams?.length) {
        for (const p of opts.extraParams) {
          try { setIfDefined(row, p, unwrapNominal(sp?.[p])); } catch {}
        }
      }

      if (opts.allParams) {
        Object.assign(row, collectAllParamsForSpace(api as any, modelID, id, relDefinesIndex));
      } else {
        const extras = collectAllParamsForSpace(api as any, modelID, id, relDefinesIndex);
        if (extras.Area   != null) row.Area   = extras.Area;
        if (extras.Volume != null) row.Volume = extras.Volume;
      }

      if (geoBySpace) {
        const g = geoBySpace.get(id);
        if (g) {
          if (g.minZ !== undefined) row['Base Elevation'] = g.minZ;
          if (g.maxZ !== undefined) row['Top Elevation']  = g.maxZ;

          if (opts.forceGeometry || row.Area == null)   row.Area   = g.area;
          if (opts.forceGeometry || row.Volume == null) row.Volume = g.volume;
        }
      }

      rows.push(row);
    }

    // Rename
    if (opts.renameMap && Object.keys(opts.renameMap).length) {
      for (const r of rows) {
        for (const [oldKey, newKey] of Object.entries(opts.renameMap)) {
          if (oldKey in r) {
            r[newKey] = r[oldKey];
            if (newKey !== oldKey) delete r[oldKey];
          }
        }
      }
    }

    return rows;
  } finally {
    api.CloseModel(modelID);
    try { (api as any).Close?.(); } catch {}
    try { (api as any).Dispose?.(); } catch {}
  }
}
