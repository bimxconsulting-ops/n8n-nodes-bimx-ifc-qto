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

// ---------- kleine Helfer ----------
function num(x: any): number {
  const v = (x && (x.value ?? x)) as any;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function polygonArea2D(pts: Array<{ x: number; y: number }>): number {
  if (!pts || pts.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - p.y * q.x;
  }
  return Math.abs(s) * 0.5;
}
function pointsFromPolyline(poly: any): Array<{ x: number; y: number }> {
  const src = poly?.Points || poly?.points || [];
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of src) {
    const c = p?.Coordinates || p?.coords || p?.value || p;
    const x = num(c?.[0]);
    const y = num(c?.[1]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
  }
  // IfcPolyline ist oft geschlossen, aber nicht immer: ggf. letzten Punkt = ersten Punkt entfernen
  if (pts.length >= 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) pts.pop();
  }
  return pts;
}

// Fläche eines Profils (häufigster Fälle) bestimmen
function areaOfProfile(profile: any): number {
  if (!profile) return 0;
  const t = String(profile?.type || profile?.Type || "").toLowerCase();

  // Rechteck
  if (t.includes("rectangleprofiledef")) {
    const a = num(profile?.XDim);
    const b = num(profile?.YDim);
    return Math.abs(a * b);
  }

  // Kreis
  if (t.includes("circleprofiledef")) {
    const r = num(profile?.Radius);
    return Math.PI * r * r;
  }

  // Ellipse
  if (t.includes("ellipseprofiledef")) {
    const a = num(profile?.SemiAxis1);
    const b = num(profile?.SemiAxis2);
    return Math.PI * a * b;
  }

  // Beliebig geschlossen mit evtl. Voids
  if (t.includes("arbitraryprofiledefwithvoids") || t.includes("arbitraryclosedprofiledef")) {
    const outer = profile?.OuterCurve || profile?.OuterBoundary || profile?.Curve || profile;
    let outerArea = 0;
    // nur IfcPolyline unterstützen (einfachster Fall)
    if (outer?.type && String(outer.type).toLowerCase().includes("polyline")) {
      outerArea = polygonArea2D(pointsFromPolyline(outer));
    }

    // innere Ränder (Voids)
    let innerArea = 0;
    const inners = profile?.InnerCurves || profile?.InnerBoundaries || [];
    for (const ic of inners) {
      if (ic?.type && String(ic.type).toLowerCase().includes("polyline")) {
        innerArea += polygonArea2D(pointsFromPolyline(ic));
      }
    }
    return Math.max(0, outerArea - innerArea);
  }

  // not supported → 0
  return 0;
}

export async function runQtoOnIFC(buffer: Buffer): Promise<Row[]> {
  const api = new IfcAPI();
  await api.Init();

  const modelID = api.OpenModel(new Uint8Array(buffer));

  // 1) IfcSpace IDs
  const spaceIDs: number[] = [];
  {
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    for (let i = 0; i < ids.size(); i++) spaceIDs.push(ids.get(i));
  }

  // 2) Rows vorbereiten
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

  // 3) Versuch A: triangulierte Meshes (wenn vorhanden)
  const applyMesh = (id: number, verts: Float32Array, inds: Uint32Array) => {
    const r = rowsById.get(id);
    if (!r) return;
    r.Area = Number((r.Area || 0) + footprintAreaXY(verts, inds));
    r.Volume = Number((r.Volume || 0) + meshVolume(verts, inds));
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
    streamAllMeshes.call(api, modelID, (mesh: any) => {
      const id = mesh.expressID ?? mesh.expressId ?? mesh.id;
      if (!rowsById.has(id)) return;
      const arrs = getArraysFrom(mesh);
      if (arrs) applyMesh(id, arrs.v, arrs.f);
    });
  } else if (typeof (api as any).LoadAllGeometry === "function") {
    const geoms: any[] = (api as any).LoadAllGeometry(modelID) || [];
    for (const g of geoms) {
      const id = g.expressID ?? g.expressId ?? g.id;
      if (!rowsById.has(id)) continue;
      const arrs = getArraysFrom(g);
      if (arrs) applyMesh(id, arrs.v, arrs.f);
    }
  }

  // 4) Versuch B (Fallback): analytische Extrusionen
  for (const id of spaceIDs) {
    const r = rowsById.get(id);
    if (!r) continue;
    // Wenn Mesh schon was geliefert hat, überspringen wir nicht – wir addieren (Dubletten in Praxis aber selten)
    const line: any = api.GetLine(modelID, id, true);
    const reps = line?.Representation?.Representations ?? [];
    for (const rep of reps) {
      for (const item of rep?.Items ?? []) {
        const typeName = String(item?.type || item?.Type || "").toLowerCase();
        if (!typeName.includes("extrudedareasolid")) continue;

        const depth = num(item?.Depth);
        if (!depth) continue;

        const swept = item?.SweptArea;
        const A = areaOfProfile(swept);
        if (!A) continue;

        r.Area = Number((r.Area || 0) + A);
        r.Volume = Number((r.Volume || 0) + A * Math.abs(depth));
      }
    }
  }

  api.CloseModel(modelID);

  // 5) Ergebnis
  return Array.from(rowsById.values()).map(r => ({
    ...r,
    Area: r.Area ?? null,
    Volume: r.Volume ?? null,
  }));
}
