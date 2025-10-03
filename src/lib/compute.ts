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

export async function runQtoOnIFC(buffer: Buffer): Promise<Row[]> {
  const api = new IfcAPI();
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));

  // --- 1) IfcSpace-IDs sammeln
  const spaceIDsSet = new Set<number>();
  {
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    for (let i = 0; i < ids.size(); i++) spaceIDsSet.add(ids.get(i));
  }

  // --- 2) Stammdaten vormerken
  const rowsById = new Map<number, Row>();
  for (const id of spaceIDsSet) {
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

  // Hilfsfunktion: aus beliebigem Mesh-Objekt Vertices/Indices holen
  const getArrays = (mesh: any): { verts: Float32Array; inds: Uint32Array } | null => {
    // Case A: Arrays sind schon direkt dran
    if (mesh?.vertices instanceof Float32Array && mesh?.indices instanceof Uint32Array) {
      return { verts: mesh.vertices, inds: mesh.indices };
    }
    // Case B: Pointer-Getter (Node-API / Geometry-Objekt)
    const vPtr =
      mesh?.GetVertexData?.() ??
      mesh?.geometry?.GetVertexData?.() ??
      mesh?.vertsPtr ??
      mesh?.vertexPtr;
    const iPtr =
      mesh?.GetIndexData?.() ??
      mesh?.geometry?.GetIndexData?.() ??
      mesh?.indsPtr ??
      mesh?.indexPtr;
    if (vPtr && iPtr) {
      const verts = new Float32Array((api as any).GetVertexArray(vPtr));
      const inds = new Uint32Array((api as any).GetIndexArray(iPtr));
      return { verts, inds };
    }
    return null;
  };

  // --- 3) Dreiecke einsammeln
  const streamAllMeshes = (api as any).StreamAllMeshes;
  if (typeof streamAllMeshes === "function") {
    // Signatur (in manchen Versionen) = (modelID, callback)
    streamAllMeshes.call(api, modelID, (mesh: any) => {
      const expressID: number = mesh.expressID ?? mesh.expressId ?? mesh.id;
      if (!spaceIDsSet.has(expressID)) return;
      const arrs = getArrays(mesh);
      if (!arrs) return;
      const a = footprintAreaXY(arrs.verts, arrs.inds);
      const v = meshVolume(arrs.verts, arrs.inds);
      const row = rowsById.get(expressID);
      if (row) {
        row.Area = Number((row.Area || 0) + a);
        row.Volume = Number((row.Volume || 0) + v);
      }
    });
  } else if (typeof (api as any).LoadAllGeometry === "function") {
    // Fallback: ganze Geometrie laden und iterieren
    const geoms: any[] = (api as any).LoadAllGeometry(modelID) || [];
    for (const g of geoms) {
      const expressID: number = g.expressID ?? g.expressId ?? g.id;
      if (!spaceIDsSet.has(expressID)) continue;
      const arrs = getArrays(g);
      if (!arrs) continue;
      const a = footprintAreaXY(arrs.verts, arrs.inds);
      const v = meshVolume(arrs.verts, arrs.inds);
      const row = rowsById.get(expressID);
      if (row) {
        row.Area = Number((row.Area || 0) + a);
        row.Volume = Number((row.Volume || 0) + v);
      }
    }
  } else {
    // letzter Notnagel: per Representation (kann 0 liefern, aber wir versuchen's)
    for (const id of spaceIDsSet) {
      const line: any = api.GetLine(modelID, id, true);
      const reps = line?.Representation?.Representations ?? [];
      for (const rep of reps) {
        for (const item of rep?.Items ?? []) {
          if (!item?.Geometry) continue;
          const geom = api.GetGeometry(modelID, item.Geometry);
          const arrs = getArrays(geom);
          if (!arrs) continue;
          const a = footprintAreaXY(arrs.verts, arrs.inds);
          const v = meshVolume(arrs.verts, arrs.inds);
          const row = rowsById.get(id);
          if (row) {
            row.Area = Number((row.Area || 0) + a);
            row.Volume = Number((row.Volume || 0) + v);
          }
        }
      }
    }
  }

  api.CloseModel(modelID);

  return Array.from(rowsById.values()).map(r => ({
    ...r,
    Area: r.Area ?? null,
    Volume: r.Volume ?? null,
  }));
}
