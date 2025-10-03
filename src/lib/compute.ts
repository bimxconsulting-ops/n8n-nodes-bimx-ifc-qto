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

  // In Node.js lädt web-ifc seine WASM-Datei automatisch (kein SetWasmPath nötig)
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));
  const ids = api.GetLineIDsWithType(modelID, IFCSPACE);

  const rows: Row[] = [];

  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    // true -> tief aufgelöste Struktur (Representation etc.)
    const line: any = api.GetLine(modelID, id, true);

    let area = 0;
    let volume = 0;

    // Es kann mehrere Repräsentationen geben – alle durchgehen
    const reps = line?.Representation?.Representations ?? [];
    for (const rep of reps) {
      const items = rep?.Items ?? [];
      for (const item of items) {
        if (!item?.Geometry) continue;

        const geom = api.GetGeometry(modelID, item.Geometry);

        // Node-API: nur je ein Pointer-Argument
        const vertsPtr = geom.GetVertexData();
        const indsPtr = geom.GetIndexData();

        // web-ifc liefert TypedArrays; für Sicherheit in gewünschte Typen casten
        const verts = new Float32Array((api as any).GetVertexArray(vertsPtr));
        const inds = new Uint32Array((api as any).GetIndexArray(indsPtr));

        area += footprintAreaXY(verts, inds);
        volume += meshVolume(verts, inds);
      }
    }

    rows.push({
      Ebene: "", // optional: später Storey ermitteln
      Name: line?.LongName || "",
      GlobalId: line?.GlobalId?.value || "",
      Nummer: line?.Name || "",
      Area: Number.isFinite(area) ? area : null,
      Volume: Number.isFinite(volume) ? volume : null,
    });
  }

  api.CloseModel(modelID);
  return rows;
}
