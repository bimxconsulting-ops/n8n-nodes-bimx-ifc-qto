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
  // In Node.js lädt web-ifc seine WASM-Datei automatisch
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));

  // 1) Alle IfcSpace-IDs erfassen
  const spaceIDsSet = new Set<number>();
  {
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    for (let i = 0; i < ids.size(); i++) spaceIDsSet.add(ids.get(i));
  }

  // 2) Lookup für Stammdaten der Spaces (Name/LongName/GlobalId)
  const rowsById = new Map<number, Row>();
  for (const id of spaceIDsSet) {
    const line: any = api.GetLine(modelID, id, true);
    rowsById.set(id, {
      Ebene: "",                               // optional: später Storey ermitteln
      Name: line?.LongName || "",
      GlobalId: line?.GlobalId?.value || "",
      Nummer: line?.Name || "",
      Area: 0,
      Volume: 0,
    });
  }

  // 3) Alle Meshes streamen und nur die von IfcSpace akkumulieren
  //    (web-ifc liefert pro Mesh expressID + Buffer-Pointer; wir holen Arrays und summieren)
  api.StreamAllMeshes(modelID, (mesh: any) => {
    const expressID: number = mesh.expressID ?? mesh.expressId ?? mesh.id;
    if (!spaceIDsSet.has(expressID)) return;

    // Je nach web-ifc-Version: direkte Arrays vorhanden ODER Pointer → über API holen
    let verts: Float32Array;
    let inds: Uint32Array;

    if (mesh.vertices instanceof Float32Array && mesh.indices instanceof Uint32Array) {
      verts = mesh.vertices;
      inds  = mesh.indices;
    } else {
      // Pointer-Variante
      const vPtr = mesh.GetVertexData ? mesh.GetVertexData() : mesh.geometry?.GetVertexData?.();
      const iPtr = mesh.GetIndexData  ? mesh.GetIndexData()  : mesh.geometry?.GetIndexData?.();
      verts = new Float32Array((api as any).GetVertexArray(vPtr));
      inds  = new Uint32Array((api as any).GetIndexArray(iPtr));
    }

    const a = footprintAreaXY(verts, inds);
    const v = meshVolume(verts, inds);

    const row = rowsById.get(expressID);
    if (row) {
      row.Area   = Number((Number(row.Area || 0) + a));
      row.Volume = Number((Number(row.Volume || 0) + v));
    }
  }, true); // true = include meshes of all items

  api.CloseModel(modelID);

  // 4) Rows zurückgeben (Filter: nur tatsächlich gefundene Spaces)
  return Array.from(rowsById.values()).map(r => ({
    ...r,
    Area: r.Area ?? null,
    Volume: r.Volume ?? null,
  }));
}
