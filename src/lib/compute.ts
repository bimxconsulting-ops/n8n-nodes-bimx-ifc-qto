// src/lib/compute.ts
import * as path from "path";
import * as WEBIFC from "web-ifc";

/**
 * Liest für alle IfcSpaces die Area/Volume.
 * 1) Psets: Pset_Revit_Dimensions, Qto_SpaceBaseQuantities, IfcElementQuantity (IfcQuantityArea/Volume)
 * 2) Fallback Geometrie: Volumen aus Dreiecksmesh (exakt, falls geschlossen),
 *    "Fläche" näherungsweise als Summe horizontaler Dreiecke (Boden/Decke).
 */
export async function runQtoOnIFC(buffer: Buffer): Promise<Array<{ GlobalId: string; Name: string; Area: number | null; Volume: number | null }>> {
  const api = new WEBIFC.IfcAPI();

  // WASM initialisieren (Node: Pfad dynamisch auflösen)
  try {
    await api.Init();
  } catch {
    try {
      const wasmDir = path.dirname(require.resolve("web-ifc/web-ifc.wasm"));
      (api as any).SetWasmPath?.(wasmDir + "/");
      await api.Init();
    } catch (err) {
      throw new Error("web-ifc WASM konnte nicht initialisiert werden: " + (err as Error).message);
    }
  }

  const modelID = api.OpenModel(new Uint8Array(buffer));
  try {
    const rows: Array<{ GlobalId: string; Name: string; Area: number | null; Volume: number | null }> = [];

    // --- Hilfsfunktionen -----------------------------------------------------
    const asStr = (v: any): string | null => {
      if (v == null) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object" && "value" in v) return String((v as any).value);
      return String(v);
    };

    const asNum = (v: any): number | null => {
      if (v == null) return null;
      if (typeof v === "number") return v;
      if (typeof v === "object" && "value" in v) {
        const n = Number((v as any).value);
        return Number.isFinite(n) ? n : null;
      }
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    // Mappe: SpaceID -> Array<PropertyDefinitionID>
    const relIDs = api.GetLineIDsWithType(modelID, WEBIFC.IFCRELDEFINESBYPROPERTIES);
    const defsByObj = new Map<number, number[]>();
    for (let i = 0; i < relIDs.size(); i++) {
      const rid = relIDs.get(i);
      const rel: any = api.GetLine(modelID, rid);
      const related: number[] = rel?.RelatedObjects || [];
      const defId: number | undefined = rel?.RelatingPropertyDefinition;
      if (!defId) continue;
      for (const objId of related) {
        const arr = defsByObj.get(objId) || [];
        arr.push(defId);
        defsByObj.set(objId, arr);
      }
    }

    // Alle IfcSpaces
    const spaceIDs = api.GetLineIDsWithType(modelID, WEBIFC.IFCSPACE);
    for (let i = 0; i < spaceIDs.size(); i++) {
      const id = spaceIDs.get(i);
      const sp: any = api.GetLine(modelID, id);

      const name = asStr(sp?.Name) ?? "";
      const gid = asStr(sp?.GlobalId) ?? String(sp?.GlobalId ?? id);

      let area: number | null = null;
      let volume: number | null = null;

      // ---- 1) Psets & Quantities -------------------------------------------
      const defs = defsByObj.get(id) || [];
      for (const defId of defs) {
        const def: any = api.GetLine(modelID, defId);
        if (!def) continue;

        // IfcPropertySet (z.B. Pset_Revit_Dimensions)
        if (def.type === WEBIFC.IFCPROPERTYSET) {
          const hasProps: number[] = def.HasProperties || [];
          for (const pid of hasProps) {
            const prop: any = api.GetLine(modelID, pid);
            if (prop?.type === WEBIFC.IFCPROPERTYSINGLEVALUE) {
              const pname = (asStr(prop?.Name) || "").toLowerCase();

              // typische Namen aus Revit & generischen Psets
              if (area == null && /^(area|grossfloorarea|netfloorarea|netarea|grossarea|basearea)$/i.test(pname)) {
                area = asNum(prop?.NominalValue);
              }
              if (volume == null && /^(volume|grossvolume|netvolume)$/i.test(pname)) {
                volume = asNum(prop?.NominalValue);
              }
            }
          }
        }

        // IfcElementQuantity (z.B. Qto_SpaceBaseQuantities in IFC2x3/IFC4)
        if (def.type === WEBIFC.IFCELEMENTQUANTITY) {
          const qs: number[] = def.Quantities || [];
          for (const qid of qs) {
            const q: any = api.GetLine(modelID, qid);
            if (!q) continue;

            if (area == null) {
              if (q.type === WEBIFC.IFCQUANTITYAREA) area = asNum(q.AreaValue);
              else if ("AreaValue" in q) area = asNum(q.AreaValue);
            }
            if (volume == null) {
              if (q.type === WEBIFC.IFCQUANTITYVOLUME) volume = asNum(q.VolumeValue);
              else if ("VolumeValue" in q) volume = asNum(q.VolumeValue);
            }
          }
        }
      }

      // ---- 2) Geometrie-Fallback -------------------------------------------
      if (area == null || volume == null) {
        try {
          // Manche web-ifc-Versionen liefern {vb, ib}, andere {vertices, indices}
          const flat: any = (api as any).GetFlatMesh?.(modelID, id);
          const V: Float32Array | undefined = flat?.vb || flat?.vertices;
          const I: Uint32Array | Uint16Array | undefined = flat?.ib || flat?.indices;

          if (V && I && I.length >= 3) {
            // Volumen via signiertes Tetraeder-Volumen
            let vol = 0;
            for (let f = 0; f < I.length; f += 3) {
              const i1 = I[f] * 3, i2 = I[f + 1] * 3, i3 = I[f + 2] * 3;
              const x1 = V[i1],     y1 = V[i1 + 1],     z1 = V[i1 + 2];
              const x2 = V[i2],     y2 = V[i2 + 1],     z2 = V[i2 + 2];
              const x3 = V[i3],     y3 = V[i3 + 1],     z3 = V[i3 + 2];

              vol += (x1 * (y2 * z3 - z2 * y3)
                    - y1 * (x2 * z3 - z2 * x3)
                    + z1 * (x2 * y3 - y2 * x3)) / 6;
            }
            if (volume == null) volume = Math.abs(vol);

            // Bodenfläche näherungsweise: Summe der Flächen von (nahezu) horizontalen Dreiecken
            if (area == null) {
              let floorArea = 0;
              for (let f = 0; f < I.length; f += 3) {
                const i1 = I[f] * 3, i2 = I[f + 1] * 3, i3 = I[f + 2] * 3;
                const ax = V[i2] - V[i1],     ay = V[i2 + 1] - V[i1 + 1], az = V[i2 + 2] - V[i1 + 2];
                const bx = V[i3] - V[i1],     by = V[i3 + 1] - V[i1 + 1], bz = V[i3 + 2] - V[i1 + 2];

                const nx = ay * bz - az * by;
                const ny = az * bx - ax * bz;
                const nz = ax * by - ay * bx;

                const areaTri = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
                // Normale ~ vertikal -> Fläche ~ horizontal -> trägt zur Boden-/Deckenfläche bei
                const verticality = Math.abs(nz) / (Math.sqrt(nx * nx + ny * ny + nz * nz) + 1e-12);
                if (verticality > 0.95) floorArea += areaTri;
              }
              area = floorArea;
            }
          }
        } catch {
          // Wenn Geometrie nicht verfügbar ist, lassen wir area/volume ggf. null
        }
      }

      rows.push({ GlobalId: gid, Name: name, Area: area ?? null, Volume: volume ?? null });
    }

    return rows;
  } finally {
    try { api.CloseModel(modelID); } catch {}
  }
}
