// src/lib/mesh-math.ts

/** 2D-Dreiecksfläche (XY-Projektion) */
export function triangleArea2D(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
): number {
  return Math.abs(ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) * 0.5;
}

/** Summe der projizierten Dreiecke → Footprint-Fläche in XY */
export function footprintAreaXY(verts: Float32Array, indices: Uint32Array): number {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    area += triangleArea2D(
      verts[i0], verts[i0 + 1],
      verts[i1], verts[i1 + 1],
      verts[i2], verts[i2 + 1]
    );
  }
  return area;
}

/** Volumenberechnung über Tetraeder-Summen (gegen Ursprung) */
export function meshVolume(verts: Float32Array, indices: Uint32Array): number {
  let vol6 = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    const ax = verts[i0], ay = verts[i0 + 1], az = verts[i0 + 2];
    const bx = verts[i1], by = verts[i1 + 1], bz = verts[i1 + 2];
    const cx = verts[i2], cy = verts[i2 + 1], cz = verts[i2 + 2];
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(vol6) / 6.0;
}

/* -------------------------------------------------------------------------- */
/*                              IFC-Geometry-Glue                              */
/* -------------------------------------------------------------------------- */

export type MeshChunk = { verts: Float32Array; indices: Uint32Array };

/**
 * Versucht, alle Mesh-Chunks (Vertices/Indices) eines Elements (expressID) zu holen.
 * Unterstützt `web-ifc`-Varianten mit `StreamAllMeshes`. Falls nicht verfügbar,
 * wird ein leeres Array zurückgegeben (kein Fehlerwurf).
 */
export function gatherMeshesForElement(
  api: any,
  modelID: number,
  expressID: number
): MeshChunk[] {
  const chunks: MeshChunk[] = [];

  if (
    typeof api?.StreamAllMeshes === 'function' &&
    typeof api?.GetVertexArray === 'function' &&
    typeof api?.GetIndexArray === 'function'
  ) {
    api.StreamAllMeshes(modelID, (mesh: any) => {
      if (!mesh || mesh.expressID !== expressID) return;

      const geoms: any[] = Array.isArray(mesh.geometries) ? mesh.geometries : [];
      for (const g of geoms) {
        try {
          const v: Float32Array = api.GetVertexArray(modelID, g.GetVertexData(), g.GetVertexDataSize());
          const i: Uint32Array  = api.GetIndexArray(modelID,  g.GetIndexData(),  g.GetIndexDataSize());
          // vom WASM lösen
          chunks.push({
            verts: new Float32Array(v),
            indices: new Uint32Array(i),
          });
        } catch {
          // einzelne Geometrie fehlerhaft → ignorieren
        }
      }
    });
  }

  return chunks;
}

/**
 * Öffentliche API für compute.ts:
 * Ermittelt – wenn möglich – Flächen- und Volumenwerte aus Mesh-Geometrie.
 * Gibt { area?, volume? } zurück; ist etwas nicht bestimmbar, bleibt es undefined.
 */
export function getSpaceAreaVolume(
  api: any,
  modelID: number,
  expressID: number
): { area?: number; volume?: number } {
  const parts = gatherMeshesForElement(api, modelID, expressID);
  if (parts.length === 0) return { area: undefined, volume: undefined };

  let areaSum = 0;
  let volSum = 0;
  for (const { verts, indices } of parts) {
    if (verts.length && indices.length) {
      areaSum += footprintAreaXY(verts, indices);
      volSum  += meshVolume(verts, indices);
    }
  }

  return {
    area: Number.isFinite(areaSum) ? areaSum : undefined,
    volume: Number.isFinite(volSum) ? volSum : undefined,
  };
}
