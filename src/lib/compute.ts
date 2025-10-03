// src/lib/compute.ts
import path from "path";
import { IfcAPI } from "web-ifc";

// Web-IFC numeric constants are not exported as enums in typings, so use hard values:
const IFCSPACE = 27; // IFC2x3 & IFC4: IfcSpace type id (stable in web-ifc)
const IFCRELDEFINESBYPROPERTIES = 418;
const IFCPROPERTYSET = 157;
const IFCRELDEFINESBYTYPE = 419;
const IFCELEMENTQUANTITY = 144;
const IFCPROPERTYSINGLEVALUE = 147;
const IFCQUANTITYAREA = 103;
const IFCQUANTITYVOLUME = 109;

type Dict<T = any> = Record<string, T>;

export interface QtoOptions {
  allParameters?: boolean;
  select?: string[];             // extra property names to pull if present
  rename?: Dict<string>;         // output key renames {old: new}
  useGeometryFallback?: boolean; // if no QTO/PSets area/volume -> try geometry
  forceGeometry?: boolean;       // always compute geometry (even if QTO exists)
  wasmPath?: string;             // optional custom wasm path
  round?: number;                // optional rounding in compute (generally leave undefined)
}

function unwrapIfcValue(v: any) {
  // web-ifc wraps typed values: { value: number|string|boolean }
  if (v == null) return v;
  if (typeof v === "object" && "value" in v) return (v as any).value;
  return v;
}

function tryNumber(x: any): number | undefined {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

// Triangle utilities
function triArea(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  // 0.5 * |(b-a) x (c-a)|
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const cxp = aby * acz - abz * acy;
  const cyp = abz * acx - abx * acz;
  const czp = abx * acy - aby * acx;
  return 0.5 * Math.sqrt(cxp * cxp + cyp * cyp + czp * czp);
}

function triSignedVolume(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number) {
  // V = (a · (b × c)) / 6
  const cxp = by * cz - bz * cy;
  const cyp = bz * cx - bx * cz;
  const czp = bx * cy - by * cx;
  return (ax * cxp + ay * cyp + az * czp) / 6.0;
}

function applyMatrix(v: [number, number, number], m?: Float32Array | number[]) {
  if (!m) return v;
  // 4x4 row-major from web-ifc; apply affine
  const x = v[0], y = v[1], z = v[2];
  const nx = m[0] * x + m[4] * y + m[8]  * z + m[12];
  const ny = m[1] * x + m[5] * y + m[9]  * z + m[13];
  const nz = m[2] * x + m[6] * y + m[10] * z + m[14];
  return [nx, ny, nz] as [number, number, number];
}

async function initIfcApi(wasmPath?: string) {
  const api = new IfcAPI();
  try {
    // Some versions expose SetWasmPath; some resolve from bundle.
    (api as any).SetWasmPath?.(wasmPath || path.join(__dirname, "web-ifc.wasm"));
  } catch { /* no-op */ }
  await api.Init();
  return api;
}

function openModel(api: IfcAPI, buffer: Buffer) {
  // Node Buffer -> ArrayBuffer
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  // Use settings that help geometry
  const settings = {
    COORDINATE_TO_ORIGIN: true,
    USE_FAST_BOOLS: true,
    CIRCLE_SEGMENTS: 14,
    // Force index type if available in your web-ifc version:
    // FORCE_32BIT_INDICES: true,
  } as any;
  return api.OpenModel(ab, settings);
}

function readNameAndLongName(api: IfcAPI, modelID: number, eid: number) {
  const el: any = api.GetLine(modelID, eid);
  return {
    Name: unwrapIfcValue(el?.Name),
    LongName: unwrapIfcValue(el?.LongName),
    GlobalId: unwrapIfcValue(el?.GlobalId),
    Tag: unwrapIfcValue(el?.Tag),
  };
}

function collectPropsForElement(api: IfcAPI, modelID: number, eid: number) {
  const out: Dict = {};
  // Find relations RelDefinesByProperties that target the element
  const relIds = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < relIds.size(); i++) {
    const rid = relIds.get(i);
    const rel: any = api.GetLine(modelID, rid);
    const related = rel?.RelatedObjects || rel?.RelatedObject; // IFC4/2x3
    let match = false;
    if (Array.isArray(related)) {
      match = related.some((r: any) => unwrapIfcValue(r?.value) === eid);
    } else if (related?.value === eid) match = true;
    if (!match) continue;

    const propSetRef = rel?.RelatingPropertyDefinition;
    const psetId = unwrapIfcValue(propSetRef?.value);
    if (!psetId) continue;

    const pset: any = api.GetLine(modelID, psetId);
    if (!pset) continue;

    // IfcPropertySet -> HasProperties (SingleValue etc.)
    if (pset?.type === IFCPROPERTYSET || pset?.HasProperties) {
      const props = pset.HasProperties ?? [];
      for (const pr of props) {
        const pid = unwrapIfcValue(pr?.value);
        if (!pid) continue;
        const p: any = api.GetLine(modelID, pid);
        const pname = unwrapIfcValue(p?.Name);
        let pval: any = undefined;

        if (p?.type === IFCPROPERTYSINGLEVALUE) {
          pval = unwrapIfcValue(p?.NominalValue);
        } else {
          pval = unwrapIfcValue(p?.NominalValue) ?? unwrapIfcValue(p?.EnumerationValues);
        }
        if (pname) out[pname] = pval;
      }
    }

    // IfcElementQuantity -> Quantities (Area/Volume etc.)
    if (pset?.type === IFCELEMENTQUANTITY || pset?.Quantities) {
      const quants = pset.Quantities ?? [];
      for (const qref of quants) {
        const qid = unwrapIfcValue(qref?.value);
        if (!qid) continue;
        const q: any = api.GetLine(modelID, qid);
        const qname = unwrapIfcValue(q?.Name);
        if (!qname) continue;

        if (q?.type === IFCQUANTITYAREA) {
          const val = tryNumber(unwrapIfcValue(q?.AreaValue));
          if (val !== undefined) out[qname] = val;
          // Also set generic aliases if meaningful
          if (qname.toLowerCase().includes("area") && out["Area"] == null) out["Area"] = val;
        } else if (q?.type === IFCQUANTITYVOLUME) {
          const val = tryNumber(unwrapIfcValue(q?.VolumeValue));
          if (val !== undefined) out[qname] = val;
          if (qname.toLowerCase().includes("volume") && out["Volume"] == null) out["Volume"] = val;
        } else {
          // Other quantities
          const known =
            unwrapIfcValue(q?.LengthValue) ??
            unwrapIfcValue(q?.CountValue) ??
            unwrapIfcValue(q?.WeightValue);
          if (known != null) out[qname] = known;
        }
      }
    }
  }
  return out;
}

// --- Geometry (mesh) collection & metrics -----------------------------------

type MeshBundle = {
  expressID: number;
  indices: Uint32Array | Uint16Array;
  vertices: Float32Array;
  matrix?: Float32Array;
};

function collectMeshesForSpaces(api: IfcAPI, modelID: number, targetIds: Set<number>): MeshBundle[] {
  const meshes: MeshBundle[] = [];
  // web-ifc exposes streaming helpers on api as any in Node
  const a: any = api as any;

  if (typeof a.StreamAllMeshes !== "function") {
    return meshes; // geometry not available in this runtime
  }

  a.StreamAllMeshes(modelID, (m: any) => {
    // m.expressID: product express id
    const id = m.expressID ?? m.id;
    if (!targetIds.has(id)) return;

    // geometry data
    const geom = m.geometry;
    const verts: Float32Array = a.GetVertexData(geom);
    const inds: Uint32Array | Uint16Array = a.GetIndexData(geom);
    const transform: Float32Array | undefined = m.flatTransformation || m.transformation;

    meshes.push({
      expressID: id,
      vertices: verts,
      indices: inds,
      matrix: transform,
    });
  });

  return meshes;
}

function areaVolumeFromMesh(vertices: Float32Array, indices: Uint32Array | Uint16Array, matrix?: Float32Array) {
  let area = 0;
  let vol = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3;
    const ib = indices[i + 1] * 3;
    const ic = indices[i + 2] * 3;

    const a = applyMatrix([vertices[ia], vertices[ia + 1], vertices[ia + 2]], matrix);
    const b = applyMatrix([vertices[ib], vertices[ib + 1], vertices[ib + 2]], matrix);
    const c = applyMatrix([vertices[ic], vertices[ic + 1], vertices[ic + 2]], matrix);

    area += triArea(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    vol += triSignedVolume(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }

  return { area, volume: Math.abs(vol) };
}

function roundN(v: any, n?: number) {
  if (typeof v !== "number" || !Number.isFinite(v) || n == null) return v;
  const f = Math.pow(10, n);
  return Math.round(v * f) / f;
}

export async function runQtoOnIFC(buffer: Buffer, options: QtoOptions = {}): Promise<Dict[]> {
  const { wasmPath, allParameters, select, rename, useGeometryFallback, forceGeometry, round } = options;

  const api = await initIfcApi(wasmPath);
  const modelID = openModel(api, buffer);

  try {
    // collect spaces
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    const spaceIds: number[] = [];
    for (let i = 0; i < ids.size(); i++) spaceIds.push(ids.get(i));
    const targetSet = new Set(spaceIds);

    // Prepare geometry if requested / needed
    let meshesById: Map<number, MeshBundle[]> | undefined;
    const needGeom = forceGeometry || useGeometryFallback;
    if (needGeom) {
      const collected = collectMeshesForSpaces(api, modelID, targetSet);
      meshesById = new Map<number, MeshBundle[]>();
      for (const m of collected) {
        const arr = meshesById.get(m.expressID) || [];
        arr.push(m);
        meshesById.set(m.expressID, arr);
      }
    }

    const rows: Dict[] = [];

    for (const eid of spaceIds) {
      const base = readNameAndLongName(api, modelID, eid);
      const props = collectPropsForElement(api, modelID, eid);

      // Select extras
      if (Array.isArray(select)) {
        for (const key of select) {
          if (base[key] == null && props[key] != null) {
            base[key] = props[key];
          } else if (base[key] == null) {
            // try from raw element
            const el: any = api.GetLine(modelID, eid);
            const v = unwrapIfcValue(el?.[key]);
            if (v != null) base[key] = v;
          }
        }
      }

      // Initial Area/Volume from quantities if available
      let area = tryNumber(props["Area"] ?? props["NetArea"] ?? props["GrossFloorArea"]);
      let volume = tryNumber(props["Volume"] ?? props["NetVolume"] ?? props["GrossVolume"]);

      // Geometry fallback / force
      if (forceGeometry || (useGeometryFallback && (area == null || volume == null))) {
        const bundles = meshesById?.get(eid) ?? [];
        let gArea = 0, gVol = 0;
        for (const b of bundles) {
          const { area: a, volume: v } = areaVolumeFromMesh(b.vertices, b.indices, b.matrix);
          gArea += a;
          gVol += v;
        }
        if (Number.isFinite(gArea) && gArea > 0) area = gArea;
        if (Number.isFinite(gVol) && gVol > 0) volume = gVol;
      }

      const row: Dict = {
        GlobalId: base.GlobalId,
        Name: base.Name,
        LongName: base.LongName,
        Tag: base.Tag,
        Area: roundN(area, round),
        Volume: roundN(volume, round),
      };

      if (allParameters) {
        // merge all props (don’t overwrite Area/Volume already set)
        for (const [k, v] of Object.entries(props)) {
          if (row[k] == null) row[k] = v;
        }
      } else if (Array.isArray(select)) {
        for (const k of select) {
          if (props[k] != null && row[k] == null) row[k] = props[k];
        }
      }

      // Rename keys if requested
      if (rename && Object.keys(rename).length) {
        for (const [oldKey, newKey] of Object.entries(rename)) {
          if (oldKey in row) {
            row[newKey] = row[oldKey];
            delete row[oldKey];
          }
        }
      }

      rows.push(row);
    }

    return rows;
  } finally {
    api.CloseModel(modelID);
    (api as any).Dispose?.();
  }
}
