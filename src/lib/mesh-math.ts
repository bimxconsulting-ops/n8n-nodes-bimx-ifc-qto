// src/lib/mesh-math.ts

/* --------------------------- Geometrische Helfer --------------------------- */

// 2D-Dreiecksfläche (XY-Projektion)
export function triangleArea2D(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
) {
  return Math.abs(ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) * 0.5;
}

// Fläche der XY-Projektion eines triangulierten Meshes
export function footprintAreaXY(verts: Float32Array, indices: Uint32Array) {
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;
    area += triangleArea2D(
      verts[i0],     verts[i0 + 1],
      verts[i1],     verts[i1 + 1],
      verts[i2],     verts[i2 + 1]
    );
  }
  return area;
}

// Volumen via Summe der Tetraeder (um den Ursprung)
export function meshVolume(verts: Float32Array, indices: Uint32Array) {
  let vol6 = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3;

    const ax = verts[i0],     ay = verts[i0 + 1],     az = verts[i0 + 2];
    const bx = verts[i1],     by = verts[i1 + 1],     bz = verts[i1 + 2];
    const cx = verts[i2],     cy = verts[i2 + 1],     cz = verts[i2 + 2];

    // ax * (by*cz - bz*cy) - ay * (bx*cz - bz*cx) + az * (bx*cy - by*cx)
    vol6 += ax * (by * cz - bz * cy)
          - ay * (bx * cz - bz * cx)
          + az * (bx * cy - by * cx);
  }
  return Math.abs(vol6) / 6.0;
}

/* -------------------- optionale 4×4-Transformationshilfe ------------------- */

function applyMatrix4ToVerts(vs: Float32Array, m: number[] | Float32Array) {
  if (!m || (m as any).length !== 16) return vs;
  const out = new Float32Array(vs.length);

  const m00 = +m[0],  m01 = +m[1],  m02 = +m[2],  m03 = +m[3];
  const m10 = +m[4],  m11 = +m[5],  m12 = +m[6],  m13 = +m[7];
  const m20 = +m[8],  m21 = +m[9],  m22 = +m[10], m23 = +m[11];
  const m30 = +m[12], m31 = +m[13], m32 = +m[14], m33 = +m[15];

  // Wir ignorieren mögliche perspektivische Komponenten (m03,m13,m23,m33)
  for (let i = 0; i < vs.length; i += 3) {
    const x = vs[i], y = vs[i + 1], z = vs[i + 2];
    out[i]     = m00 * x + m10 * y + m20 * z + m30;
    out[i + 1] = m01 * x + m11 * y + m21 * z + m31;
    out[i + 2] = m02 * x + m12 * y + m22 * z + m32;
  }
  return out;
}

/* ---------------------- web-ifc Mesh → Area/Volume API --------------------- */

/**
 * Holt alle FlatMeshes über `web-ifc`, filtert auf den gegebenen IfcSpace
 * (expressID), trianguliert & summiert daraus XY-Fläche und Volumen.
 *
 * Erwartet die Node-API von `web-ifc` (IfcAPI). Wir typisieren alles defensiv mit `any`,
 * um API-Änderungen zwischen Versionen nicht sofort kaputt zu machen.
 */
export function getSpaceAreaVolume(api: any, modelID: number, spaceExpressID: number) {
  // Falls der Build keine Geometrie liefert, geben wir nichts zurück
  if (!api || typeof api.LoadAllGeometry !== 'function') {
    return {};
  }

  let area = 0;
  let volume = 0;
  let found = false;

  const flatMeshes = api.LoadAllGeometry(modelID);
  const size = typeof flatMeshes?.size === 'function' ? flatMeshes.size() : 0;

  for (let i = 0; i < size; i++) {
    const fm: any = flatMeshes.get(i);
    // Nur Geometrie des gewünschten IfcSpace
    if ((fm?.expressID ?? fm?.ExpressID) !== spaceExpressID) continue;
    found = true;

    const geom: any = api.GetGeometry(modelID, fm.geometryExpressID);
    if (!geom) continue;

    // web-ifc liefert Pointer + Size → in TypedArrays mappen
    const vRaw: Float32Array = api.GetArray(geom.GetVertexData(), geom.GetVertexDataSize());
    const iRaw: any = api.GetArray(geom.GetIndexData(), geom.GetIndexDataSize());

    // Indices sauber als Uint32Array vorliegen lassen
    const indices = (iRaw instanceof Uint32Array) ? iRaw : new Uint32Array(iRaw);
    let verts = vRaw;

    // Mögliche Transformationsmatrix anwenden (Namensvarianten abdecken)
    const m =
      (fm && (fm.matrix || fm.transformMatrix || fm.coordinationMatrix || fm.transform)) || null;

    if (m && (m as any).length === 16) {
      verts = applyMatrix4ToVerts(verts, m as any);
    }

    area   += footprintAreaXY(verts, indices);
    volume += meshVolume(verts, indices);

    // Optional: Geometrie freigeben, falls API das unterstützt
    if (typeof api.ReleaseGeometry === 'function') {
      try { api.ReleaseGeometry(modelID, fm.geometryExpressID); } catch {}
    }
  }

  if (!found) return {};
  return {
    area: area > 0 ? area : undefined,
    volume: volume > 0 ? volume : undefined,
  };
}
