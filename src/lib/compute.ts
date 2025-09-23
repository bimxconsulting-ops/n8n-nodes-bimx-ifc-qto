import path from "path";
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
  // lädt die in /dist/wasm kopierte wasm-Datei
  await api.SetWasmPath(path.join(__dirname, "..", "..", "wasm"));
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));
  const ids = api.GetLineIDsWithType(modelID, IFCSPACE);

  const rows: Row[] = [];

  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    const line: any = api.GetLine(modelID, id, true);

    let area = 0, volume = 0;
    const rep = line?.Representation?.Representations?.[0];

    if (rep?.Items) {
      for (const item of rep.Items) {
        if (!item.Geometry) continue;
        const geom = api.GetGeometry(modelID, item.Geometry);

        // neu: mit der „ein Argument“-Signatur arbeiten
        // (einige Type-Defs erlauben nur ptr statt (modelID, ptr, size))
        const vertsPtr = geom.GetVertexData();
        const indsPtr  = geom.GetIndexData();

        // web-ifc liefert TypedArrays; zur Sicherheit in die gewünschten Typen casten
        const verts = new Float32Array((api as any).GetVertexArray(geom.GetVertexData()));
        const inds  = new Uint32Array((api as any).GetIndexArray(geom.GetIndexData()));


        area   += footprintAreaXY(verts, inds);
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
