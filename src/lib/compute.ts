// src/lib/compute.ts

import {
  IfcAPI,
  // Entitäten/Relationen
  IFCSPACE,
  IFCPROJECT,
  IFCBUILDINGSTOREY,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  // Property-Typen
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCELEMENTQUANTITY,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

import { footprintAreaXY, meshVolume } from './mesh-math';

/* --------------------------------- Optionen -------------------------------- */

export interface QtoOptions {
  allParams?: boolean;       // alle Psets/Quantities/zusätzliche Attribute
  useGeometry?: boolean;     // Fallback Geometrie (wenn keine QTO-Werte)
  forceGeometry?: boolean;   // Geometrie erzwingen (überschreibt QTO)
  extraParams?: string[];    // explizit zusätzliche Attribute der IfcSpace-Entity
  renameMap?: Record<string, string>;
  round?: number;            // Rundung (wird normalerweise im Node angewandt)
}

/* ------------------------------ Utility-Helper ------------------------------ */

// Lokale 4x4-Transformation (dupliziert, um nicht von mesh-math exportieren zu müssen)
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

function toUint32(arr: any) {
  return arr instanceof Uint32Array ? arr : new Uint32Array(arr as ArrayLike<number>);
}

function unwrapNominal(v: any): any {
  // web-ifc umschachtelt Werte häufig als .value
  if (v == null) return v;
  if (typeof v === 'object' && 'value' in v) return (v as any).value;
  return v;
}

function setIfDefined(obj: Record<string, any>, key: string, val: any) {
  if (val !== undefined && val !== null) obj[key] = val;
}

/* ----------------------- Relationen vorab indizieren ----------------------- */

/** Mappt ElementID -> Array<PropertyDefinitionID> (PSet / ElementQuantity) */
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
      if (!eid && eid !== 0) continue;
      if (!map.has(eid)) map.set(eid, []);
      map.get(eid)!.push(defId);
    }
  }
  return map;
}

/** Mappt ElementID -> StoreyID (über IfcRelContainedInSpatialStructure) */
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

/** Mappt ID -> Name (für Projekte/Storeys) */
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

/* --------------- Geometrie schnell sammeln (ein Durchlauf) ---------------- */

type GeoStats = {
  area: number;
  volume: number;
  tris: number;
  minZ: number;
  maxZ: number;
};

function collectSpaceGeometryFast(
  api: any,
  modelID: number,
  opts: {
    triangleLimit?: number;      // Hard-Limit für Gesamt-Triangles
    firstMeshPerSpace?: boolean; // Schnell, aber evtl. unvollständig
  } = {}
) {
  const { triangleLimit = 3_000_000, firstMeshPerSpace = false } = opts;

  const perSpace = new Map<number, GeoStats>();
  let totalTris = 0;

  const consumeMesh = (fm: any) => {
    // Nur IfcSpace-Meshes berücksichtigen
    const cat = fm?.category ?? fm?.type ?? 0;
    if (cat !== IFCSPACE) return;

    const sid = fm?.expressID ?? fm?.ExpressID;
    if (sid == null) return;
    if (firstMeshPerSpace && perSpace.has(sid)) return;

    const g: any = api.GetGeometry(modelID, fm.geometryExpressID);
    if (!g) return;

    const vRaw: Float32Array = api.GetArray(g.GetVertexData(), g.GetVertexDataSize());
    const iRaw: any = api.GetArray(g.GetIndexData(), g.GetIndexDataSize());
    const idx = toUint32(iRaw);
    const tris = idx.length / 3;

    totalTris += tris;
    if (triangleLimit && totalTris > triangleLimit) return;

    let verts = vRaw;
    const m =
      (fm && (fm.matrix || fm.transformMatrix || fm.coordinationMatrix || fm.transform)) || null;
    if (m && (m as any).length === 16) {
      verts = applyMatrix4ToVerts(verts, m as any);
    }

    // Area & Volume
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

    const prev = perSpace.get(sid) ?? { area: 0, volume: 0, tris: 0, minZ: +Infinity, maxZ: -Infinity };
    prev.area += a;
    prev.volume += v;
    prev.tris += tris;
    prev.minZ = Math.min(prev.minZ, minZ);
    prev.maxZ = Math.max(prev.maxZ, maxZ);
    perSpace.set(sid, prev);

    if (typeof api.ReleaseGeometry === 'function') {
      try { api.ReleaseGeometry(modelID, fm.geometryExpressID); } catch {}
    }
  };

  if (typeof api.StreamAllMeshes === 'function') {
    // Schneller Pfad: direkt nur IFCSPACE streamen
    try {
      api.StreamAllMeshes(modelID, (fm: any) => consumeMesh(fm), [IFCSPACE]);
    } catch {
      // Fallback auf LoadAllGeometry, falls ältere web-ifc-Version
      const fms: any = api.LoadAllGeometry(modelID);
      const size = typeof fms?.size === 'function' ? fms.size() : 0;
      for (let i = 0; i < size; i++) consumeMesh(fms.get(i));
    }
  } else {
    // Fallback: alles laden – aber nur EIN Durchlauf
    const fms: any = api.LoadAllGeometry(modelID);
    const size = typeof fms?.size === 'function' ? fms.size() : 0;
    for (let i = 0; i < size; i++) consumeMesh(fms.get(i));
  }

  // Aufräumen: unendliche Extents zu undefined
  for (const [k, s] of perSpace) {
    if (!isFinite(s.minZ)) s.minZ = undefined as any;
    if (!isFinite(s.maxZ)) s.maxZ = undefined as any;
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
            const nval = unwrapNominal(pl.NominalValue);
            if (pname) {
              // z. B. "Pset_WallCommon.FireRating" – hier Spaces: "GASA Space Areas.Gasa BIM Area"
              out[`${psetName}.${pname}`] = nval;
            }
          } else {
            // andere Property-Typen defensiv abbilden
            const pname = unwrapNominal(pl.Name) || `Prop_${p.value}`;
            const raw = { ...pl };
            // Versuch, generischen .NominalValue zu finden
            const nv = unwrapNominal((pl as any).NominalValue);
            out[`${psetName}.${pname}`] = nv != null ? nv : raw;
          }
        }
      }
    } else if (def.type === IFCELEMENTQUANTITY) {
      // QTOs – Area/Volume etc.
      if (Array.isArray(def.Quantities)) {
        for (const q of def.Quantities) {
          const ql = api.GetLine(modelID, q.value);
          if (!ql) continue;
          const qName = unwrapNominal(ql.Name);
          if (ql.type === IFCQUANTITYAREA) {
            const val = unwrapNominal(ql.AreaValue);
            if (qName) out[qName] = val;
            // Standardfelder
            setIfDefined(out, 'Area', out['Area'] ?? val);
          } else if (ql.type === IFCQUANTITYVOLUME) {
            const val = unwrapNominal(ql.VolumeValue);
            if (qName) out[qName] = val;
            setIfDefined(out, 'Volume', out['Volume'] ?? val);
          } else {
            // andere Mengenarten (Length, Count, etc.)
            const nv =
              unwrapNominal((ql as any).LengthValue) ??
              unwrapNominal((ql as any).CountValue) ??
              unwrapNominal((ql as any).WeightValue) ??
              unwrapNominal((ql as any).TimeValue);
            if (qName && nv != null) out[qName] = nv;
          }
        }
      }
    } else {
      // unbekannter PropertyDefinition-Typ → komplett sichern
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

  // Node: Buffer → Uint8Array (präzise inkl. Offsets)
  const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const modelID = api.OpenModel(u8);

  try {
    // Vorab-Indices (für Geschwindigkeit bei ALL PARAMETERS)
    const relDefinesIndex = buildRelDefinesIndex(api as any, modelID);
    const relContainedIndex = buildRelContainedIndex(api as any, modelID);
    const projectNames = buildNameIndex(api as any, modelID, IFCPROJECT);
    const storeyNames  = buildNameIndex(api as any, modelID, IFCBUILDINGSTOREY);

    // Optional: Geometrie nur EINMAL streamen/sammeln
    let geoBySpace: Map<number, GeoStats> | undefined;
    if (opts.useGeometry || opts.forceGeometry) {
      geoBySpace = collectSpaceGeometryFast(api as any, modelID, {
        triangleLimit: 3_000_000,
        firstMeshPerSpace: false,
      });
    }

    // Räume sammeln
    const rows: Array<Record<string, any>> = [];
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    const it = ids[Symbol.iterator]();

    // Project-Name (erster Eintrag reicht idR.)
    let Project: string | undefined;
    for (const [, v] of projectNames) { Project = v.Name; break; }

    for (let idRes = it.next(); !idRes.done; idRes = it.next()) {
      const id = idRes.value as number;
      const sp: any = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: unwrapNominal(sp?.GlobalId),
        Name:     unwrapNominal(sp?.Name),
        LongName: unwrapNominal(sp?.LongName),
      };

      // Basis-Kontext: Project / Storey
      if (Project) row.Project = Project;

      const storeyId = relContainedIndex.get(id);
      if (storeyId != null) {
        const s = storeyNames.get(storeyId);
        if (s?.Name) row.Storey = s.Name;
        if (s?.Elevation != null) row['Storey Elevation'] = s.Elevation;
      }

      // extraParams (direkt von der Space-Entity)
      if (opts.extraParams?.length) {
        for (const p of opts.extraParams) {
          try { setIfDefined(row, p, unwrapNominal(sp?.[p])); } catch {}
        }
      }

      // ALL PARAMETERS → Psets/Quantities vollständig einlesen
      if (opts.allParams) {
        const extras = collectAllParamsForSpace(api as any, modelID, id, relDefinesIndex);
        Object.assign(row, extras);
      } else {
        // Minimal: nur QTO Area/Volume, wenn vorhanden
        const extras = collectAllParamsForSpace(api as any, modelID, id, relDefinesIndex);
        if (extras.Area != null)   row.Area   = extras.Area;
        if (extras.Volume != null) row.Volume = extras.Volume;
      }

      // Geometry-Fallback / -Force
      if (geoBySpace) {
        const g = geoBySpace.get(id);
        if (g) {
          // Elevations aus Geometrie
          if (g.minZ !== undefined) row['Base Elevation'] = g.minZ;
          if (g.maxZ !== undefined) row['Top Elevation']  = g.maxZ;

          if (opts.forceGeometry || row.Area == null)   row.Area   = g.area;
          if (opts.forceGeometry || row.Volume == null) row.Volume = g.volume;
        }
      }

      rows.push(row);
    }

    // Rename anwenden
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
    // Toleranter Cleanup (versch. web-ifc-Versionen)
    try { (api as any).Close?.(); } catch {}
    try { (api as any).Dispose?.(); } catch {}
  }
}
