// src/lib/compute.ts
import {
  IfcAPI,
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
  IFCPROPERTYSINGLEVALUE,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from "web-ifc";

export interface QtoOptions {
  extraParameters?: string[];    // zusätzliche Parameter (case-insensitive)
  allParameters?: boolean;       // alle Parameter/Quantities flatten
  geometryFallback?: boolean;    // falls QTO fehlt → Geometrie aus Mesh
  geometryForce?: boolean;       // immer Geometrie verwenden (überschreibt QTO)
}

type Dict = Record<string, any>;

function asId(ref: any): number | undefined {
  if (ref === null || ref === undefined) return undefined;
  if (typeof ref === "number") return ref;
  if (typeof ref === "object" && "value" in ref && typeof ref.value === "number") return ref.value;
  const num = Number(ref);
  return Number.isFinite(num) ? num : undefined;
}
function asStr(v: any): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "value" in v) return String((v as any).value);
  return undefined;
}
function asNum(v: any): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "value" in v && typeof (v as any).value === "number") return (v as any).value;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function getVecIds(vec: any): number[] {
  if (!vec || typeof vec.size !== "function" || typeof vec.get !== "function") return [];
  const out: number[] = [];
  const n = vec.size();
  for (let i = 0; i < n; i++) out.push(vec.get(i));
  return out;
}
function pickFirstDefined<T>(...candidates: (T | undefined)[]): T | undefined {
  for (const c of candidates) if (c !== undefined) return c;
  return undefined;
}
function pushKv(target: Dict, key: string, val: any) {
  if (val === undefined || val === null) return;
  target[key] = val;
}
function lowercaseSet(arr?: string[]) {
  return new Set((arr || []).map((s) => s.toLowerCase().trim()).filter(Boolean));
}

async function collectRelsByProps(ifc: IfcAPI, modelID: number, elementId: number) {
  const relIds = getVecIds(ifc.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES));
  const hits: any[] = [];
  for (const rid of relIds) {
    const rel = ifc.GetLine(modelID, rid);
    if (!rel) continue;
    const related = Array.isArray(rel.RelatedObjects) ? rel.RelatedObjects : [];
    const has = related.some((r: any) => asId(r) === elementId);
    if (has) hits.push(rel);
  }
  return hits;
}

function readPropSingleValue(ifc: IfcAPI, modelID: number, pid: number) {
  const p = ifc.GetLine(modelID, pid);
  if (!p) return undefined as unknown as { name?: string; value?: any };
  const name = asStr(p.Name);
  const val = p.NominalValue && typeof p.NominalValue === "object" && "value" in p.NominalValue
    ? (p.NominalValue as any).value
    : p.NominalValue ?? p.Description ?? p.EnumerationValues ?? undefined;
  return { name, value: val };
}

function readElementQuantities(ifc:
