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
    const a = pts[0], b
