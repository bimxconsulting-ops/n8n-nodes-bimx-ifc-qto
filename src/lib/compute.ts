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
} from "web-ifc";

export interface QtoOptions {
  extraParameters?: string[];    // zusätzliche Parameter (case-insensitive)
  allParameters?: boolean;       // alle Parameter/Quantities flatten
  geometryFallback?: boolean;    // falls QTO fehlt → Geometrie aus Mesh
  geometryForce?: boolean;       // immer Geometrie verwenden (überschreibt QTO)
}

type Dict = Record<string, any>;

function asId(ref: any): number | undefined {
  if (ref === null || ref === undefined) return undefined;
  if (typeof ref === "number") return ref;
  if (typeof ref === "object" && "value" in ref && typeof ref.value === "number") return ref.value;
  const num = Number(ref);
  return Number.isFinite(num) ? num : undefined;
}
function asStr(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "value" in v) return String((v as any).value);
  return undefined;
}
function asNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "value" in v && typeof (v as any).value === "number") return (v as any).value;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function getVecIds(vec: any): number[] {
  if (!vec || typeof vec.size !== "function" || typeof vec.get !== "function") return [];
  const out: number[] = [];
  const n = vec.size();
  for (let i = 0; i < n; i++) out.push(vec.get(i));
  return out;
}
function pickFirstDefined<T>(...candidates: (T | undefined)[]): T | undefined {
  for (const c of candidates) if (c !== undefined) return c;
  return undefined;
}
function pushKv(target: Dict, key: string, val: any) {
  if (val === undefined || val === null) return;
  target[key] = val;
}
function lowercaseSet(arr?: string[]) {
  return new Set((arr || []).map((s) => s.toLowerCase().trim()).filter(Boolean));
}

async function collectRelsByProps(ifc: IfcAPI, modelID: number, elementId: number) {
  const relIds = getVecIds(ifc.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES));
  const hits: any[] = [];
  for (const rid of relIds) {
    const rel = ifc.GetLine(modelID, rid);
    if (!rel) continue;
    const related = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [];
    const has = related.some((r: any) => asId(r) === elementId);
    if (has) hits.push(rel);
  }
  return hits;
}

function readPropSingleValue(ifc: IfcAPI, modelID: number, pid: number) {
  const p = ifc.GetLine(modelID, pid);
  if (!p) return undefined as unknown as { name?: string; value?: any };
  const name = asStr(p.Name);
  const val = p.NominalValue && typeof p.NominalValue === "object" && "value" in p.NominalValue
    ? (p.NominalValue as any).value
    : p.NominalValue ?? p.Description ?? p.EnumerationValues ?? undefined;
  return { name, value: val };
}

function readElementQuantities(ifc: IfcAPI, modelID: number, qtoId: number) {
  const qto = ifc.GetLine(modelID, qtoId);
  if (!qto) return { name: undefined as string | undefined, pairs: {} as Dict };
  const qtoName = asStr(qto.Name);
  const result: Dict = {};
  const qIds: number[] = Array.isArray(qto.Quantities) ? qto.Quantities.map(asId).filter(Boolean) as number[] : [];
  for (const qid of qIds) {
    const q = qid ? ifc.GetLine(modelID, qid) : undefined;
    if (!q) continue;
    const qName = asStr(q.Name) || String(qid);
    if (q.expressID && q.type === IFCQUANTITYAREA) {
      const v = pickFirstDefined(asNum(q.AreaValue), asNum((q as any).Value), asNum((q as any).LengthValue));
      pushKv(result, qName, v);
    } else if (q.expressID && q.type === IFCQUANTITYVOLUME) {
      const v = pickFirstDefined(asNum(q.VolumeValue), asNum((q as any).Value));
      pushKv(result, qName, v);
    } else {
      const v = pickFirstDefined(
        asNum((q as any).Value),
        asNum((q as any).LengthValue),
        asNum((q as any).AreaValue),
        asNum((q as any).VolumeValue),
      ) ?? asStr((q as any).Value);
      pushKv(result, qName, v);
    }
  }
  return { name: qtoName, pairs: result };
}

function readPropertySet(ifc: IfcAPI, modelID: number, psetId: number) {
  const pset = ifc.GetLine(modelID, psetId);
  if (!pset) return { name: undefined as string | undefined, pairs: {} as Dict };
  const psetName = asStr(pset.Name);
  const pairs: Dict = {};
  const pIds: number[] = Array.isArray(pset.HasProperties) ? pset.HasProperties.map(asId).filter(Boolean) as number[] : [];
  for (const pid of pIds) {
    const prop = pid ? ifc.GetLine(modelID, pid) : undefined;
    if (!prop) continue;
    if (prop.type === IFCPROPERTYSINGLEVALUE) {
      const r = readPropSingleValue(ifc, modelID, pid);
      if (r?.name) pairs[r.name] = r.value;
    } else {
      const name = asStr((prop as any).Name) || String(pid);
      const val =
        pickFirstDefined(asStr((prop as any).NominalValue), asStr((prop as any).Description)) ??
        (typeof (prop as any).NominalValue === "object" && (prop as any).NominalValue?.value);
      if (name && val !== undefined) pairs[name] = val;
    }
  }
  return { name: psetName, pairs };
}

/* ---------------- Geometry helpers ---------------- */

type AV = { area: number; volume: number };

function triArea(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const cxp = aby * acz - abz * acy;
  const cyp = abz * acx - abx * acz;
  const czp = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
}
function triSignedVolume(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  // 1/6 * dot(a, cross(b, c))
  const cxp = by * cz - bz * cy;
  const cyp = bz * cx - bx * cz;
  const czp = bx * cy - by * cx;
  return (ax * cxp + ay * cyp + az * czp) / 6.0;
}

function accumulateAreaVolumeFromBuffers(pos: Float32Array | number[], idx: Uint32Array | Uint16Array | number[]): AV {
  let area = 0;
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i] * 3, i1 = idx[i + 1] * 3, i2 = idx[i + 2] * 3;
    const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
    const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
    const cx = pos[i2], cy = pos[i2 + 1], cz = pos[i2 + 2];
    area += triArea(ax, ay, az, bx, by, bz, cx, cy, cz);
    vol += triSignedVolume(ax, ay, az, bx, by, bz, cx, cy, cz);
  }
  return { area, volume: Math.abs(vol) }; // falls Orientierung uneinheitlich ist
}

/**
 * Streamt alle IfcSpace-Meshes einmal und berechnet je ExpressID die Summe aus Fläche/Volumen.
 * Hinweis: web-ifc hat hier je nach Version leicht unterschiedliche Membernamen → defensiv (any).
 */
function computeGeometryQTOForSpaces(ifc: IfcAPI, modelID: number): Map<number, AV> {
  const acc = new Map<number, AV>();
  const api: any = ifc as any;

  if (typeof api.StreamAllMeshes !== "function" || typeof api.GetGeometry !== "function" || typeof api.GetArray !== "function") {
    // API nicht verfügbar → leer
    return acc;
  }

  api.StreamAllMeshes(
    modelID,
    (mesh: any) => {
      try {
        const expressID: number = mesh.expressID ?? mesh.ExpressID ?? mesh.id;
        const geomRef = mesh.geometry ?? mesh.geometryExpressID ?? mesh.geometryID;
        if (expressID == null || geomRef == null) return;

        const geom = api.GetGeometry(modelID, geomRef);
        if (!geom) return;

        const vertPtr = geom.GetVertexData();
        const vertSize = geom.GetVertexDataSize();
        const idxPtr = geom.GetIndexData();
        const idxSize = geom.GetIndexDataSize();

        const pos = api.GetArray(vertPtr, vertSize) as Float32Array;
        const idx = api.GetArray(idxPtr, idxSize) as Uint32Array;

        const res = accumulateAreaVolumeFromBuffers(pos, idx);
        const prev = acc.get(expressID);
        if (prev) {
          acc.set(expressID, { area: prev.area + res.area, volume: prev.volume + res.volume });
        } else {
          acc.set(expressID, res);
        }
      } catch {
        /* skip silently */
      }
    },
    [IFCSPACE] // nur Spaces streamen
  );

  return acc;
}

/* ---------------- Main runner ---------------- */

export async function runQtoOnIFC(buffer: Buffer | Uint8Array, opts: QtoOptions = {}) {
  const ifc = new IfcAPI();
  await ifc.Init();

  const modelID = ifc.OpenModel(buffer as any);
  try {
    const spaceIds = getVecIds(ifc.GetLineIDsWithType(modelID, IFCSPACE));

    const allRows: Dict[] = [];
    const wantAll = !!opts.allParameters;
    const extraSet = lowercaseSet(opts.extraParameters);

    // Geometrie-Map lazy berechnen (nur wenn benötigt)
    let geomMap: Map<number, AV> | null = null;
    const ensureGeom = () => {
      if (!geomMap) geomMap = computeGeometryQTOForSpaces(ifc, modelID);
      return geomMap!;
    };

    for (const sid of spaceIds) {
      const s = ifc.GetLine(modelID, sid);
      if (!s) continue;

      const base: Dict = { ExpressID: sid };
      pushKv(base, "GlobalId", asStr(s.GlobalId));
      pushKv(base, "Name", asStr(s.Name));
      pushKv(base, "LongName", asStr(s.LongName));
      pushKv(base, "Description", asStr(s.Description));
      pushKv(base, "ObjectType", asStr(s.ObjectType));
      pushKv(base, "Tag", asStr(s.Tag));

      const rels = await collectRelsByProps(ifc, modelID, sid);

      const flatAll: Dict = {};
      let areaFromQto: number | undefined;
      let volumeFromQto: number | undefined;

      for (const rel of rels) {
        const propDefId = asId(rel.RelatingPropertyDefinition);
        if (!propDefId) continue;
        const pd = ifc.GetLine(modelID, propDefId);
        if (!pd) continue;

        if (pd.type === IFCELEMENTQUANTITY) {
          const { name: qName, pairs } = readElementQuantities(ifc, modelID, propDefId);
          const candArea = pickFirstDefined(
            asNum(pairs["NetFloorArea"]),
            asNum(pairs["GrossFloorArea"]),
            asNum(pairs["Area"]),
          );
          const candVol = pickFirstDefined(
            asNum(pairs["NetVolume"]),
            asNum(pairs["GrossVolume"]),
            asNum(pairs["Volume"]),
          );
          areaFromQto = areaFromQto ?? candArea;
          volumeFromQto = volumeFromQto ?? candVol;

          if (qName) {
            for (const [k, v] of Object.entries(pairs)) flatAll[`${qName}.${k}`] = v;
          } else {
            for (const [k, v] of Object.entries(pairs)) flatAll[k] = v;
          }
        } else if (pd.type === IFCPROPERTYSET) {
          const { name: pName, pairs } = readPropertySet(ifc, modelID, propDefId);
          for (const [k, v] of Object.entries(pairs)) {
            const keyFlat = pName ? `${pName}.${k}` : k;
            flatAll[keyFlat] = v;
            if (extraSet.has(k.toLowerCase())) base[k] = v;
          }
        }
      }

      // Geometrie anwenden (force oder fallback)
      let geoArea: number | undefined;
      let geoVol: number | undefined;
      if (opts.geometryForce || (opts.geometryFallback && (areaFromQto === undefined || volumeFromQto === undefined))) {
        const g = ensureGeom().get(sid);
        if (g) {
          geoArea = g.area;
          geoVol = g.volume;
        }
      }

      // Priorität: geometryForce ? Geo : QTO → Fallback Geo → undefined
      const area = opts.geometryForce ? geoArea ?? areaFromQto : (areaFromQto ?? geoArea);
      const volume = opts.geometryForce ? geoVol ?? volumeFromQto : (volumeFromQto ?? geoVol);

      if (area !== undefined) base["Area"] = area;
      if (volume !== undefined) base["Volume"] = volume;

      if (wantAll) {
        for (const [k, v] of Object.entries(flatAll)) {
          if (base[k] === undefined) base[k] = v;
        }
      }

      allRows.push(base);
    }

    return allRows;
  } finally {
    try { ifc.CloseModel(modelID); } catch {}
  }
}
