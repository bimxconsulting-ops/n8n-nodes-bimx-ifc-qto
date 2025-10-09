// src/lib/compute.ts
import * as path from 'path';
import * as fs from 'fs';
import * as WebIFC from 'web-ifc';

type Opts = {
  allParams?: boolean;
  useGeometry?: boolean;
  forceGeometry?: boolean;
  extraParams?: string[];
  renameMap?: Record<string, string>;
  round?: number;
};

const val = (x: any) => (x && typeof x === 'object' && 'value' in x ? x.value : x);
const num = (x: any) => {
  const v = val(x);
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
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
  // Shoelace
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
  // dist/lib/compute.js -> dist/wasm/web-ifc.wasm
  const wasmDir = path.join(__dirname, '..', 'wasm');
  const wasmFile = path.join(wasmDir, 'web-ifc.wasm');
  return fs.existsSync(wasmFile) ? wasmDir : undefined;
}

async function openModel(ifcApi: WebIFC.IfcAPI, data: Uint8Array) {
  const wasmDir = findWasmDir();
  // web-ifc Versionen unterscheiden sich: versuche SetWasmPath falls vorhanden
  try {
    if (wasmDir && typeof (ifcApi as any).SetWasmPath === 'function') {
      (ifcApi as any).SetWasmPath(wasmDir);
    }
  } catch {}
  await ifcApi.Init();
  const modelID = ifcApi.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
  return modelID;
}

function extractPsetsAndQuantities(
  ifcApi: WebIFC.IfcAPI,
  modelID: number,
  space: any,
  opts: Opts,
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

    // IfcElementQuantity -> Quantities (IfcQuantityArea / IfcQuantityVolume)
    if (pdef.type === WebIFC.IFCENTITYENUM.IFCELEMENTQUANTITY || pdef.GlobalId) {
      const qs = pdef.Quantities || [];
      for (const qRef of qs) {
        const q = ifcApi.GetLine(modelID, qRef.value, true);
        if (!q) continue;
        if (q.type === WebIFC.IFCENTITYENUM.IFCQUANTITYAREA && area === undefined) {
          area = num(q.AreaValue);
          if (opts.allParams) row[q.Name?.value || 'IfcQuantityArea'] = area;
        } else if (q.type === WebIFC.IFCENTITYENUM.IFCQUANTITYVOLUME && volume === undefined) {
          volume = num(q.VolumeValue);
          if (opts.allParams) row[q.Name?.value || 'IfcQuantityVolume'] = volume;
        }
      }
    }

    // IfcPropertySet -> IfcPropertySingleValue
    if (pdef.type === WebIFC.IFCENTITYENUM.IFCPROPERTYSET) {
      const props = pdef.HasProperties || [];
      for (const pRef of props) {
        const prop = ifcApi.GetLine(modelID, pRef.value, true);
        if (!prop) continue;
        const pname = prop.Name?.value;
        const nval = prop.NominalValue ? val(prop.NominalValue) : undefined;

        if (opts.allParams && pname) row[pname] = nval;

        // ExtraParams: nur auf Wunsch sicherstellen
        if (opts.extraParams?.includes(pname)) row[pname] = nval;

        // Manche Modelle speichern Area/Volume als Pset-Value
        if (area === undefined && /area/i.test(pname ?? '') && typeof nval === 'number') area = nval;
        if (volume === undefined && /volume|volumen/i.test(pname ?? '') && typeof nval === 'number') volume = nval;
      }
    }
  }

  if (area !== undefined) row['Area'] = area;
  if (volume !== undefined) row['Volume'] = volume;
}

function geometryFromExtrusion(ifcApi: WebIFC.IfcAPI, modelID: number, space: any) {
  // Sehr verbreitet: IfcExtrudedAreaSolid
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

      if (item.type === WebIFC.IFCENTITYENUM.IFCEXTRUDEDAREASOLID) {
        const depth = num(item.Depth) ?? 0;
        const swept = item.SweptArea ? ifcApi.GetLine(modelID, item.SweptArea.value, true) : null;

        // Rechteckprofil
        if (swept?.type === WebIFC.IFCENTITYENUM.IFCRECTANGLEPROFILEDEF) {
          const x = num(swept.XDim) ?? 0;
          const y = num(swept.YDim) ?? 0;
          const a = x * y;
          return { area: a, volume: a * depth };
        }

        // Beliebiges geschlossenes Profil mit IfcPolyline
        if (
          swept?.type === WebIFC.IFCENTITYENUM.IFCARBITRARYCLOSEDPROFILEDEF &&
          swept.OuterCurve?.value
        ) {
          const oc = ifcApi.GetLine(modelID, swept.OuterCurve.value, true);
          if (oc?.type === WebIFC.IFCENTITYENUM.IFCPOLYLINE) {
            const pts: Array<{ x: number; y: number }> = [];
            for (const pRef of oc.Points || []) {
              const p = ifcApi.GetLine(modelID, pRef.value, true);
              const xs = p.Coordinates?.[0] ? num(p.Coordinates[0]) : 0;
              const ys = p.Coordinates?.[1] ? num(p.Coordinates[1]) : 0;
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
  opts: Opts = {}
): Promise<Array<Record<string, any>>> {
  const ifcApi = new WebIFC.IfcAPI();
  const modelID = await openModel(ifcApi, new Uint8Array(buffer));

  try {
    const ids = ifcApi.GetLineIDsWithType(modelID, WebIFC.IFCENTITYENUM.IFCSPACE);
    const rows: Array<Record<string, any>> = [];

    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      const space = ifcApi.GetLine(modelID, id, true);
      if (!space) continue;

      const row: Record<string, any> = {
        GlobalId: space.GlobalId?.value,
        Name: space.Name?.value ?? null,
        LongName: space.LongName?.value ?? null,
      };

      // 1) Psets/Quantities
      extractPsetsAndQuantities(ifcApi, modelID, space, opts, row);

      // 2) Geometrie-Fallback
      const needGeom =
        !!opts.forceGeometry ||
        (!!opts.useGeometry && (row['Area'] === undefined || row['Volume'] === undefined));

      if (needGeom) {
        const g = geometryFromExtrusion(ifcApi, modelID, space);
        if (row['Area'] === undefined && g.area !== undefined) row['Area'] = g.area;
        if (row['Volume'] === undefined && g.volume !== undefined) row['Volume'] = g.volume;
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
