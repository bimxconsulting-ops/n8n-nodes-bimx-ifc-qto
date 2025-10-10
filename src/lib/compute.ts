// src/lib/compute.ts

import {
  IfcAPI,
  // Typkonstanten
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
  IFCRELAGGREGATES,
  IFCBUILDINGSTOREY,
  IFCPROJECT,
} from 'web-ifc';

import { getSpaceAreaVolume } from './mesh-math';

/* -------------------------------------------------------------------------- */
/*                                   Optionen                                 */
/* -------------------------------------------------------------------------- */

export interface QtoOptions {
  allParams?: boolean;              // alle PropertySets/Quantities exportieren
  useGeometry?: boolean;            // Geometrie-Fallback erlauben (Mesh/Extrusion)
  forceGeometry?: boolean;          // Geometrie-Werte erzwingen (über Pset-Werte)
  extraParams?: string[];           // zusätzliche Feldpfade (z.B. "Space.Number")
  renameMap?: Record<string, string>; // Spalten umbenennen
  round?: number;                   // Dezimalstellen zum Runden
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

// defensiv runden
function roundIf(v: any, digits?: number) {
  if (v == null || !isFinite(Number(v)) || digits == null) return v;
  const f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}

// generisches Unwrapping von IFC-Werten -> primitiv (string/number/bool)
function toPrimitive(val: any): any {
  let v = val;
  // häufig: { value: X }
  while (v && typeof v === 'object' && 'value' in v && Object.keys(v).length === 1) {
    v = v.value;
  }
  // manche IFC-Werte sind erneut verschachtelt
  if (v && typeof v === 'object' && 'value' in v && typeof v.value !== 'object') {
    v = v.value;
  }
  return v;
}

// einfache Param-Setzung mit optionalem Überschreiben (force)
function setIfEmpty(row: Record<string, any>, key: string, value: any, force = false) {
  if (value == null) return;
  if (force || row[key] == null) row[key] = value;
}

// Rename Map anwenden
function applyRename(row: Record<string, any>, rename?: Record<string, string>) {
  if (!rename) return;
  for (const [oldKey, newKey] of Object.entries(rename)) {
    if (oldKey in row) {
      row[newKey] = row[oldKey];
      if (newKey !== oldKey) delete row[oldKey];
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                          Relationen & Kontext (fast)                       */
/* -------------------------------------------------------------------------- */

// Baut child -> parent Map aus IfcRelAggregates
function buildAggregatesIndex(api: any, modelID: number) {
  const childToParent = new Map<number, number>();

  const ids = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  for (let it = ids[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
    const relId = r.value as number;
    const rel = api.GetLine(modelID, relId);
    const parent = rel?.RelatingObject?.value;
    const children = rel?.RelatedObjects ?? [];
    if (!parent || !Array.isArray(children)) continue;
    for (const c of children) {
      if (c?.value) childToParent.set(c.value, parent);
    }
  }
  return childToParent;
}

function getNameMapForTypes(api: any, modelID: number, typeConst: number) {
  const map = new Map<number, string>();
  const ids = api.GetLineIDsWithType(modelID, typeConst);
  for (let it = ids[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
    const id = r.value as number;
    const line = api.GetLine(modelID, id);
    const nm = toPrimitive(line?.Name);
    if (nm != null) map.set(id, nm);
  }
  return map;
}

function resolveStoreyAndProject(
  childToParent: Map<number, number>,
  storeyNames: Map<number, string>,
  projectNames: Map<number, string>,
  startId: number,
) {
  let cur: number | undefined = startId;
  let storey: string | undefined;
  let project: string | undefined;

  const MAX_HOPS = 16;
  let hops = 0;
  while (cur != null && hops++ < MAX_HOPS) {
    const parent = childToParent.get(cur);
    if (parent == null) break;
    if (!storey && storeyNames.has(parent)) storey = storeyNames.get(parent);
    if (!project && projectNames.has(parent)) project = projectNames.get(parent);
    cur = parent;
  }
  return { storey, project };
}

/* -------------------------------------------------------------------------- */
/*                     All-Parameters: Psets & Quantities                     */
/* -------------------------------------------------------------------------- */

function extractPsetProps(api: any, modelID: number, psetLine: any) {
  // IfcPropertySet.HasProperties[]
  const out: Record<string, any> = {};
  const pName = toPrimitive(psetLine?.Name) ?? 'Pset';
  const props = psetLine?.HasProperties ?? [];
  for (const p of props) {
    const pid = p?.value;
    if (!pid) continue;
    const pl = api.GetLine(modelID, pid);
    const nm = toPrimitive(pl?.Name);
    if (!nm) continue;
    // meist IfcPropertySingleValue.NominalValue
    const val = toPrimitive(pl?.NominalValue ?? pl?.NominalValue?.value ?? pl?.value);
    out[`${pName}.${nm}`] = val;
  }
  return out;
}

function extractQuantities(api: any, modelID: number, qtoLine: any) {
  // IfcElementQuantity.Quantities[]
  const out: Record<string, any> = {};
  const qName = toPrimitive(qtoLine?.Name) ?? 'Qto';
  const quants = qtoLine?.Quantities ?? [];
  for (const q of quants) {
    const qid = q?.value;
    if (!qid) continue;
    const ql = api.GetLine(modelID, qid);
    const nm = toPrimitive(ql?.Name);
    const area = toPrimitive(ql?.AreaValue);
    const vol  = toPrimitive(ql?.VolumeValue);
    const len  = toPrimitive(ql?.LengthValue ?? ql?.PerimeterValue);
    if (nm) {
      if (area != null) out[`${qName}.${nm}`] = area;
      else if (vol != null) out[`${qName}.${nm}`] = vol;
      else if (len != null) out[`${qName}.${nm}`] = len;
    }
  }
  return out;
}

// Mappt RelatedObjectID -> Array<PropertyDefinitionLine>
function buildRelDefinesIndex(api: any, modelID: number) {
  const byRelated = new Map<number, any[]>();
  const ids = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  for (let it = ids[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
    const relId = r.value as number;
    const rel = api.GetLine(modelID, relId);
    const related = rel?.RelatedObjects ?? [];
    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId || !Array.isArray(related)) continue;
    const defLine = api.GetLine(modelID, defId);
    for (const ro of related) {
      const rid = ro?.value;
      if (!rid) continue;
      if (!byRelated.has(rid)) byRelated.set(rid, []);
      byRelated.get(rid)!.push(defLine);
    }
  }
  return byRelated;
}

/* -------------------------------------------------------------------------- */
/*            ExtrudedAreaSolid-Fallback (ohne Triangulator/Logs)             */
/* -------------------------------------------------------------------------- */

function polygonArea2D(pts: Array<{ x: number; y: number }>) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
  }
  return Math.abs(a) * 0.5;
}

function getPoint2DFromCartesian(api: any, modelID: number, id: number) {
  const cp = api.GetLine(modelID, id);
  const c = cp?.Coordinates;
  const x = +((c?.[0]?.value) ?? 0);
  const y = +((c?.[1]?.value) ?? 0);
  return { x, y };
}

function areaOfPolylineProfile(api: any, modelID: number, polyId: number) {
  const pl = api.GetLine(modelID, polyId);
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of (pl?.Points ?? [])) {
    if (p?.value) pts.push(getPoint2DFromCartesian(api, modelID, p.value));
  }
  if (pts.length >= 3) return polygonArea2D(pts);
  return 0;
}

function areaOfRectangleProfile(api: any, modelID: number, rectId: number) {
  const r = api.GetLine(modelID, rectId);
  const x = +((r?.XDim?.value) ?? r?.XDim ?? 0);
  const y = +((r?.YDim?.value) ?? r?.YDim ?? 0);
  return Math.max(0, x) * Math.max(0, y);
}

function areaOfCircleProfile(api: any, modelID: number, circleId: number) {
  const c = api.GetLine(modelID, circleId);
  const r = +((c?.Radius?.value) ?? c?.Radius ?? 0);
  return Math.PI * r * r;
}

// Profilsfläche (unterstützt Polyline/Rectangle/Circle/ArbitraryClosed/Composite)
function areaOfProfile(api: any, modelID: number, profId: number): number {
  const p = api.GetLine(modelID, profId);
  if (!p) return 0;

  switch (p.type) {
    // IFCPOLYLINE (häufig direkt referenziert)
    case 102:
      return areaOfPolylineProfile(api, modelID, profId);
    // IFCARBITRARYCLOSEDPROFILEDEF
    case 32522: {
      let A = 0;
      const outer = p.OuterCurve?.value;
      if (outer) {
        const oc = api.GetLine(modelID, outer);
        if (oc?.type === 102) A += areaOfPolylineProfile(api, modelID, outer);
      }
      const inners = p.InnerCurves ?? [];
      for (const ic of inners) {
        const id = ic?.value;
        if (!id) continue;
        const oc = api.GetLine(modelID, id);
        if (oc?.type === 102) A -= areaOfPolylineProfile(api, modelID, id);
      }
      return A;
    }
    // IFCCOMPOSITEPROFILEDEF
    case 1572748253: {
      const subs = p.Profiles ?? [];
      const areas: number[] = [];
      for (const sp of subs) {
        const sid = sp?.value;
        if (!sid) continue;
        areas.push(areaOfProfile(api, modelID, sid));
      }
      if (!areas.length) return 0;
      areas.sort((a, b) => b - a);
      const outer = areas[0];
      const holes = areas.slice(1).reduce((s, v) => s + v, 0);
      return Math.max(0, outer - holes);
    }
    // IFCRECTANGLEPROFILEDEF
    case 3326135071:
      return areaOfRectangleProfile(api, modelID, profId);
    // IFCCIRCLEPROFILEDEF
    case 100892965:
      return areaOfCircleProfile(api, modelID, profId);
    default:
      return 0;
  }
}

function getAxisPlacementZ(api: any, modelID: number, place: any): number | undefined {
  const locId = place?.Location?.value;
  if (!locId) return undefined;
  const cp = api.GetLine(modelID, locId);
  const c = cp?.Coordinates;
  const z = +((c?.[2]?.value) ?? c?.[2] ?? 0);
  return isFinite(z) ? z : undefined;
}

function computeExtrudedAreaSolid(api: any, modelID: number, item: any) {
  // IfcExtrudedAreaSolid
  const profId = item?.SweptArea?.value;
  const depth = +((item?.Depth?.value) ?? item?.Depth ?? 0);
  if (!profId || depth <= 0) return;

  const A = areaOfProfile(api, modelID, profId);
  if (A <= 0) return;

  let baseZ: number | undefined;
  let topZ: number | undefined;
  const pos = item?.Position;
  if (pos && pos.value) {
    const plc = api.GetLine(modelID, pos.value);
    baseZ = getAxisPlacementZ(api, modelID, plc);
    if (baseZ != null) topZ = baseZ + depth;
  }

  return { area: A, volume: A * depth, base: baseZ, top: topZ };
}

function getSpaceAreaVolumeFromRepresentation(api: any, modelID: number, spaceId: number) {
  const sp = api.GetLine(modelID, spaceId);
  const rep = sp?.Representation?.value ? api.GetLine(modelID, sp.Representation.value) : null;
  if (!rep || !Array.isArray(rep.Representations)) return;

  let area = 0, volume = 0;
  let base: number | undefined, top: number | undefined;

  for (const r of rep.Representations) {
    const rid = r?.value;
    if (!rid) continue;
    const sr = api.GetLine(modelID, rid);
    const items = sr?.Items ?? [];
    for (const it of items) {
      const iid = it?.value;
      if (!iid) continue;
      const item = api.GetLine(modelID, iid);
      // IFCEXTRUDEDAREASOLID
      if (item?.type === 3591900460) {
        const res = computeExtrudedAreaSolid(api, modelID, item);
        if (res) {
          area += res.area;
          volume += res.volume;
          if (res.base != null) base = (base == null) ? res.base : Math.min(base, res.base);
          if (res.top  != null) top  = (top  == null) ? res.top  : Math.max(top,  res.top);
        }
      }
    }
  }
  if (area > 0 || volume > 0) return { area, volume, base, top };
}

/* -------------------------------------------------------------------------- */
/*                                   Hauptlogik                               */
/* -------------------------------------------------------------------------- */

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const {
    allParams = true,
    useGeometry = true,
    forceGeometry = false,
    extraParams = [],
    renameMap,
    round,
  } = opts;

  const api = new IfcAPI();

  // In Node KEIN SetWasmPath! web-ifc findet web-ifc-node.wasm selbst.
  await api.Init();

  // Wichtig: Uint8Array übergeben
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    /* -------------------------- Vorindizes für Performance -------------------------- */

    // RelAggregates: für Storey/Project
    const childToParent = buildAggregatesIndex(api as any, modelID);
    const storeyNames   = getNameMapForTypes(api as any, modelID, IFCBUILDINGSTOREY);
    const projectNames  = getNameMapForTypes(api as any, modelID, IFCPROJECT);

    // Pset/Zuweisungen
    const relDefsByRelated = allParams ? buildRelDefinesIndex(api as any, modelID) : new Map();

    /* --------------------------------- Space IDs ----------------------------------- */

    const spaceIds = api.GetLineIDsWithType(modelID, IFCSPACE);

    const rows: Array<Record<string, any>> = [];

    for (let it = spaceIds[Symbol.iterator](), r = it.next(); !r.done; r = it.next()) {
      const id = r.value as number;
      const space = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: toPrimitive(space?.GlobalId),
        Name: toPrimitive(space?.Name),
        LongName: toPrimitive(space?.LongName),
        Number: toPrimitive(space?.Tag ?? space?.Number),
      };

      // Storey / Project
      const { storey, project } = resolveStoreyAndProject(
        childToParent,
        storeyNames,
        projectNames,
        id,
      );
      if (storey) row['Storey'] = storey;
      if (project) row['Project'] = project;

      /* ----------------------------- All Parameters ----------------------------- */
      if (allParams) {
        const defs = relDefsByRelated.get(id) ?? [];
        for (const def of defs) {
          if (!def?.type) continue;
          if (def.type === IFCPROPERTYSET) {
            Object.assign(row, extractPsetProps(api as any, modelID, def));
          } else if (def.type === IFCELEMENTQUANTITY) {
            Object.assign(row, extractQuantities(api as any, modelID, def));
          } else {
            // manche Tools schreiben direkt ElementQuantity/PropertySet Ableitungen → defensiv ignorieren wir andere Typen
          }
        }
      }

      /* ------------------------- Geometrie (Mesh) – schnell ------------------------- */
      if (useGeometry || forceGeometry) {
        const res = getSpaceAreaVolume(api as any, modelID, id);
        if (res && (res as any).area != null) {
          const a = roundIf((res as any).area, round);
          const v = roundIf((res as any).volume, round);
          setIfEmpty(row, 'Area', a, forceGeometry);
          setIfEmpty(row, 'Volume', v, forceGeometry);
        }
      }

      /* -------------- ExtrudedAreaSolid-Fallback (ohne Triangulation) -------------- */
      if ((row.Area == null && row.Volume == null) || forceGeometry) {
        const rep = getSpaceAreaVolumeFromRepresentation(api as any, modelID, id);
        if (rep) {
          setIfEmpty(row, 'Area',   roundIf(rep.area, round),   forceGeometry);
          setIfEmpty(row, 'Volume', roundIf(rep.volume, round), forceGeometry);
          if (rep.base != null) setIfEmpty(row, 'Base Elevation', roundIf(rep.base, round), false);
          if (rep.top  != null) setIfEmpty(row, 'Top Elevation',  roundIf(rep.top,  round), false);
        }
      }

      /* --------------------------- Extra Param-Pfade --------------------------- */
      for (const p of extraParams) {
        try {
          // sehr einfacher Pfad-Resolver: "Space.X" -> space.X
          if (p.startsWith('Space.')) {
            const k = p.slice('Space.'.length);
            const v = toPrimitive((space as any)?.[k]);
            if (v != null) row[k] = v;
          }
        } catch { /* noop */ }
      }

      // Runden für alle numerischen Felder (falls round gesetzt)
      if (typeof round === 'number') {
        for (const [k, v] of Object.entries(row)) {
          if (v != null && isFinite(Number(v))) {
            row[k] = roundIf(v, round);
          }
        }
      }

      // Rename Map anwenden
      applyRename(row, renameMap);

      rows.push(row);
    }

    return rows;
  } finally {
    // Aufräumen – aktuelle web-ifc Versionen besitzen meist nur CloseModel
    try { api.CloseModel(modelID); } catch {}
    // (kein api.Dispose(); bewusst weggelassen für Kompatibilität)
  }
}
