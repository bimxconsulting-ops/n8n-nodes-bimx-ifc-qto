// src/lib/compute.ts
import { IfcAPI, IFCSPACE } from "web-ifc";
import { footprintAreaXY, meshVolume } from "./mesh-math";

export type Row = {
  Ebene: string;
  Name: string;
  GlobalId: string;
  Nummer: string;
  Area: number | null;
  Volume: number | null;
};

function polygonArea2D(points: Array<{ x: number; y: number }>): number {
  // Shoelace
  let s = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    s += p.x * q.y - p.y * q.x;
  }
  return Math.abs(s) * 0.5;
}

export async function runQtoOnIFC(buffer: Buffer): Promise<Row[]> {
  const api = new IfcAPI();
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));

  // --- 1) IfcSpace-IDs sammeln
  const spaceIDs: number[] = [];
  {
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    for (let i = 0; i < ids.size(); i++) spaceIDs.push(ids.get(i));
  }

  // --- 2) Stammdaten vorbereiten
  const rowsById = new Map<number, Row>();
  for (const id of spaceIDs) {
    const line: any = api.GetLine(modelID, id, true);
    rowsById.set(id, {
      Ebene: "",
      Name: line?.LongName || "",
      GlobalId: line?.GlobalId?.value || "",
      Nummer: line?.Name || "",
      Area: 0,
      Volume: 0,
    });
  }

  // --- 3) Versuch 1: triangulierte Meshes einsammeln
  let collectedAnyMesh = false;
  const applyMesh = (expressID: number, verts: Float32Array, inds: Uint32Array) => {
    if (!rowsById.has(expressID)) return;
    collectedAnyMesh = true;
    const a = footprintAreaXY(verts, inds);
    const v = meshVolume(verts, inds);
    const r = rowsById.get(expressID)!;
    r.Area = Number((r.Area || 0) + a);
    r.Volume = Number((r.Volume || 0) + v);
  };

  const getArraysFrom = (mesh: any): { v: Float32Array; f: Uint32Array } | null => {
    if (mesh?.vertices instanceof Float32Array && mesh?.indices instanceof Uint32Array) {
      return { v: mesh.vertices, f: mesh.indices };
    }
    const vPtr = mesh?.GetVertexData?.() ?? mesh?.geometry?.GetVertexData?.();
    const iPtr = mesh?.GetIndexData?.() ?? mesh?.geometry?.GetIndexData?.();
    if (vPtr && iPtr) {
      const v = new Float32Array((api as any).GetVertexArray(vPtr));
      const f = new Uint32Array((api as any).GetIndexArray(iPtr));
      return { v, f };
    }
    return null;
  };

  const streamAllMeshes = (api as any).StreamAllMeshes;
  if (typeof streamAllMeshes === "function") {
    // Signatur in manchen Versionen: (modelID, callback)
    streamAllMeshes.call(api, modelID, (mesh: any) => {
      const id = mesh.expressID ?? mesh.expressId ?? mesh.id;
      if (!rowsById.has(id)) return;
      const arrs = getArraysFrom(mesh);
      if (!arrs) return;
      applyMesh(id, arrs.v, arrs.f);
    });
  } else if (typeof (api as any).LoadAllGeometry === "function") {
    const geoms: any[] = (api as any).LoadAllGeometry(modelID) || [];
    for (const g of geoms) {
      const id = g.expressID ?? g.expressId ?? g.id;
      if (!rowsById.has(id)) continue;
      const arrs = getArraysFrom(g);
      if (!arrs) continue;
      applyMesh(id, arrs.v, arrs.f);
    }
  }

  // --- 4) Versuch 2 (Fallback): analytische Extrusionen auslesen
  //     Nur wenn bisher nichts (oder 0) ankam.
  const needAnalytic = [...rowsById.values()].some(r => !r.Area || !r.Volume);
  if (needAnalytic) {
    for (const id of spaceIDs) {
      const line: any = api.GetLine(modelID, id, true);
      const reps = line?.Representation?.Representations ?? [];
      let areaAdd = 0;
      let volAdd = 0;

      for (const rep of reps) {
        for (const item of rep?.Items ?? []) {
          const solid = item; // z.B. IfcExtrudedAreaSolid
          const type = solid?.type || solid?.Type || solid?.__proto__?.constructor?.name;
          if (!type) continue;

          // Sehr konservativer Fallback: nur IfcExtrudedAreaSolid + IfcPolyline
          if (String(type).toLowerCase().includes("extrudedareasolid")) {
            const depth = Number(solid?.Depth?.value ?? solid?.Depth ?? 0);
            const dir = solid?.ExtrudedDirection?.DirectionRatios ?? solid?.ExtrudedDirection?.value;
            const length = Math.abs(Number.isFinite(depth) ? depth : 0);
            if (!length) continue;

            const swept = solid?.SweptArea;
            // IfcArbitraryClosedProfileDef / IfcRectangleProfileDef usw. – wir behandeln Polyline-Fall
            const outer = swept?.OuterCurve || swept?.OuterBoundary || swept?.Curve || swept;
            const pts = (outer?.Points || outer?.points || [])
              .map((p: any) => {
                const c = p?.Coordinates || p?.coords || p?.value;
                const x = Number(c?.[0]?.value ?? c?.[0] ?? 0);
                const y = Number(c?.[1]?.value ?? c?.[1] ?? 0);
                return { x, y };
              })
              .filter((p: any) => Number.isFinite(p.x) && Number.isFinite(p.y));
            if (pts.length >= 3) {
              const a = polygonArea2D(pts);
              areaAdd += a;
              volAdd += a * length;
            }
          }
        }
      }

      if ((areaAdd || volAdd) && rowsById.has(id)) {
        const r = rowsById.get(id)!;
        r.Area = Number((r.Area || 0) + areaAdd);
        r.Volume = Number((r.Volume || 0) + volAdd);
      }
    }
  }

  api.CloseModel(modelID);

  // --- 5) Ergebnis
  return Array.from(rowsById.values()).map(r => ({
    ...r,
    Area: r.Area ?? null,
    Volume: r.Volume ?? null,
  }));
}
