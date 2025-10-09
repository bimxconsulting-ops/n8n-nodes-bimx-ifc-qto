// src/lib/compute.ts
import * as path from 'path';
import * as fs from 'fs';
import * as WebIFC from 'web-ifc';

export interface QtoOptions {
  /** alle Properties & Quantities mitschreiben */
  allParams?: boolean;
  /** falls Area/Volume fehlen: aus Geometrie versuchen */
  useGeometry?: boolean;
  /** Geometrie immer berechnen (überschreibt vorhandene Werte nicht) */
  forceGeometry?: boolean;
  /** zusätzliche Parameternamen explizit auslesen */
  extraParams?: string[];
  /** Spaltennamen umbenennen */
  renameMap?: Record<string, string>;
  /** nur für Rundung im Node UI (hier nicht benutzt) */
  round?: number;
}

const asVal = (x: any) => (x && typeof x === 'object' && 'value' in x ? (x as any).value : x);
const asNum = (x: any) => {
  const v = asVal(x);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? (n as number) : undefined;
};

function renameKeys(row: Record<string, any>, map: Record<string, string>) {
  for (const [from, to] of Object.entries(map)) {
    if (from in row) {
      row[to] = row[from];
      delete row[from];
    }
  }
  return row;
}

function polygonArea2D(points: Array<{ x: number; y: number }>) {
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

function findWasmDir() {
  const wasmDir = path.join(__dirname, '..', 'wasm');
  const wasmFile = path.join(wasmDir, 'web-ifc.wasm');
  return fs.existsSync(wasmFile) ? wasmDir : undefined;
}

async function openModel(ifcApi: WebIFC.IfcAPI, buf: Buffer) {
  const wasmDir = findWasmDir();
  try {
    if (wasmDir && typeof (ifcApi as any).SetWasmPath === 'function') {
      (ifcApi as any).SetWasmPath(wasmDir);
    }
  } catch {}
  await ifcApi.Init();

  // SICHER in Uint8Array wandeln (korrekter Offset/Length!)
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const modelID = ifcApi.OpenModel(u8, { COORDINATE_TO_ORIGIN: true } as any);
  return modelID;
}

function extractPsetsAndQuantities(
  ifcApi: WebIFC.IfcAPI,
  modelID: number,
  space: any,
  opts: QtoOptions,
  row: Record<string, any>
) {
  let area: number | undefined;
  let volume: number | undefined;

  const inv = space.IsDefinedBy || [];
  for (const invRef of inv) {
    const rel = ifcApi.GetLine(modelID, invRef.value, true);
    if (!rel?.RelatingPropertyDefinition) continue;
    const pdef = ifcApi.GetLine(modelID, rel.RelatingPropertyDefinition.value, true);
    if (!pdef) continue;

    // --- IfcElementQuantity ---
    if (pdef.type === WebIFC.IFCELEMENTQUANTITY) {
      const qs = pdef.Quantities || [];
      for (const qRef of qs) {
        const q = ifcApi.GetLine(modelID, qRef.value, true);
        if (!q) continue;

        if (q.type === WebIFC.IFCQUANTITYAREA && area === undefined) {
          area = asNum(q.AreaValue);
          if (opts.allParams) row[q.Name?.value || 'IfcQuantityArea'] = area;
        } else if (q.type === WebIFC.IFCQUANTITYVOLUME && volume === undefined) {
          volume = asNum(q.VolumeValue);
          if (opts.allParams) row[q.Name?.value || 'IfcQuantityVolume'] = volume;
        }
      }
    }

    // --- IfcPropertySet ---
    if (pdef.type === WebIFC.IFCPROPERTYSET) {
      const props = pdef.HasProperties || [];
      for (const pRef of props) {
        const prop = ifcApi.GetLine(modelID, pRef.value, true);
        if (!prop) continue;
        const pname = prop.Name?.value as string | undefined;
        const nval = prop.NominalValue ? asVal(prop.NominalValue) : undefined;

        if (opts.allParams && pname) row[pname] = nval;
        if (pname && opts.extraParams?.includes(pname)) row[pname] = nval;

        if (area === undefined && pname && /area/i.test(pname) && typeof nval === 'number') {
          area = nval;
        }
        if (volume === undefined && pname && /volume|volumen/i.test(pname) && typeof nval === 'number') {
          volume = nval;
        }
      }
    }
  }

  if (area !== undefined) row.Area = area;
  if (volume !== undefined) row.Volume = volume;
}

function geometryFromExtrusion(ifcApi: WebIFC.IfcAPI, modelID: number, space: any) {
  const repRef = space.Representation;
  if (!repRef?.value) return { area: undefined, volume: undefined };

  const repDef = ifcApi.GetLine(modelID, repRef.value, true);
  const reps = repDef?.Representations || [];
  for (const rRef of reps) {
    const r = ifcApi.GetLine(modelID, rRef.value, true);
    const items = r?.Items || [];
    for (const itRef of items) {
      const item = ifcApi.GetLine(modelID, itRef.value, true);
      if (!item) continue;

      if (item.type === WebIFC.IFCEXTRUDEDAREASOLID) {
        const depth = asNum(item.Depth) ?? 0;
        const swept = item.SweptArea ? ifcApi.GetLine(modelID, item.SweptArea.value, true) : null;

        if (swept?.type === WebIFC.IFCRECTANGLEPROFILEDEF) {
          const x = asNum(swept.XDim) ?? 0;
          const y = asNum(swept.YDim) ?? 0;
          const a = x * y;
          return { area: a, volume: a * depth };
        }

        if (swept?.type === WebIFC.IFCARBITRARYCLOSEDPROFILEDEF && swept.OuterCurve?.value) {
          const oc = ifcApi.GetLine(modelID, swept.OuterCurve.value, true);
          if (oc?.type === WebIFC.IFCPOLYLINE) {
            const pts: Array<{ x: number; y: number }> = [];
            for (const pRef of oc.Points || []) {
              const p = ifcApi.GetLine(modelID, pRef.value, true);
              const xs = p.Coordinates?.[0] ? asNum(p.Coordinates[0]) : 0;
              const ys = p.Coordinates?.[1] ? asNum(p.Coordinates[1]) : 0;
              pts.push({ x: xs ?? 0, y: ys ?? 0 });
            }
            const a = polygonArea2D(pts);
            return { area: a, volume: a * depth };
          }
        }
      }
    }
  }
  return { area: undefined, volume: undefined };
}

export async function runQtoOnIFC(
  buffer: Buffer,
  opts: QtoOptions = {}
): Promise<Array<Record<string, any>>> {
  const ifcApi = new WebIFC.IfcAPI();
  const modelID = await openModel(ifcApi, buffer);

  try {
    const ids = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCSPACE);
    const rows: Array<Record<string, any>> = [];

    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const space = ifcApi.GetLine(modelID, id, true);
      if (!space) continue;

      const row: Record<string, any> = {
        GlobalId: space.GlobalId?.value ?? undefined,
        Name: space.Name?.value ?? null,
        LongName: space.LongName?.value ?? null,
      };

      // 1) Psets/Quantities
      extractPsetsAndQuantities(ifcApi, modelID, space, opts, row);

      // 2) Geometrie
      const needGeom =
        !!opts.forceGeometry ||
        (!!opts.useGeometry && (row.Area === undefined || row.Volume === undefined));
      if (needGeom) {
        const g = geometryFromExtrusion(ifcApi, modelID, space);
        if (row.Area === undefined && g.area !== undefined) row.Area = g.area;
        if (row.Volume === undefined && g.volume !== undefined) row.Volume = g.volume;
      }

      // 3) Rename
      if (opts.renameMap) renameKeys(row, opts.renameMap);

      rows.push(row);
    }

    return rows;
  } finally {
    ifcApi.CloseModel(modelID);
  }
}
