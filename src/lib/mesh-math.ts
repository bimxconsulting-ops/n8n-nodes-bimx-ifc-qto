export function triangleArea2D(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number
) {
  return Math.abs(ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) * 0.5;
}

export function footprintAreaXY(verts: Float32Array, indices: Uint32Array) {
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

export function meshVolume(verts: Float32Array, indices: Uint32Array) {
  // Summe der Tetraeder (gegen Ursprung)
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

