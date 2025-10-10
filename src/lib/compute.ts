// src/lib/compute.ts

import {
  IfcAPI,
  // Entitäten/Beziehungen
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCPROPERTYSET,
  IFCRELAGGREGATES,
  IFCBUILDINGSTOREY,
  IFCPROJECT,
  // optionale Typkonstanten (nicht zwingend vorhanden je nach Web-IFC-Version)
  // Wir prüfen primär strukturell, nicht nur über .type-IDs.
} from 'web-ifc';

// ⚠️ Wir rufen den Mesh-Pfad NICHT mehr auf, um GetMesh()-Errors zu vermeiden.
// import { getSpaceAreaVolume } from './mesh-math';

export interface QtoOptions {
  allParams?: boolean;
  useGeometry?: boolean;     // bedeuted hier: Repräsentation (Extrusion/BRep) nutzen
  forceGeometry?: boolean;   // Geometriewerte dürfen Pset/Qto-Werte überschreiben
  extraParams?: string | string[];   // <- flexibler: String ODER Array
  renameMap?: Record<string, string>;
  round?: number;
}

/* ------------------------------ Utility/Helper ----------------------------- */

function forEachIdVector(vec: any, cb: (id: number) => void) {
  const size =
    typeof vec?.size === 'function' ? vec.size()
    : Array.isArray(vec) ? vec.length
    : 0;
  for (let i = 0; i < size; i++) {
    const id = typeof vec?.get === 'function' ? vec.get(i) : vec[i];
    if (id != null) cb(id as number);
  }
}

function toPrimitive(val: any): any {
  let v = val;
  while (v && typeof v === 'object' && 'value' in v && Object.keys(v).length === 1) v = v.value;
  if (v && typeof v === 'object' && 'value' in v && typeof v.value !== 'object') v = v.value;
  return v;
}

function roundIf(v: any, digits?: number) {
  if (v == null || !isFinite(Number(v)) || digits == null) return v;
  const f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}

function setIfEmpty(row: Record<string, any>, key: string, value: any, force = false) {
  if (value == null) return;
  if (force || row[key] == null) row[key] = value;
}

function applyRename(row: Record<string, any>, rename?: Record<string, string>) {
  if (!rename) return;
  for (const [oldKey, nu] of Object.entries(rename)) {
    if (oldKey in row) {
      row[nu] = row[oldKey];
      if (nu !== oldKey) delete row[oldKey];
    }
  }
}

/** ---------------- Extra-Parameter: Normalisieren & Auflösen ---------------- **/

// "a,b;c \n d"  ->  ["a","b","c","d"]
function splitExtraParams(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const s = Array.isArray(raw) ? raw.join(',') : raw;
  return s.split(/[\n,;]+/g).map(t => t.trim()).filter(Boolean);
}

// Mappt Eingaben wie "WallCovering" auf kanonische Keys wie "Pset_SpaceCommon.WallCovering"
function resolveExtraKeys(tokens: string[], availableKeys: string[]): string[] {
  if (!tokens.length || !availableKeys.length) return [];
  const unique: string[] = [];
  const push = (k: string) => { if (k && !unique.includes(k)) unique.push(k); };

  const lcAvail = availableKeys.map(k => k.toLowerCase());

  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;

    // Space.* lassen wir hier durch – wird separat gelesen
    if (t.toLowerCase().startsWith('space.')) continue;

    if (t.includes('.')) {
      // Voller Key angegeben
      const idx = lcAvail.indexOf(t.toLowerCase());
      if (idx >= 0) push(availableKeys[idx]);
      continue;
    }

    // Nur der Property-Name -> als Suffix matchen
    const suffix = '.' + t.toLowerCase();
    const cands: string[] = [];
    lcAvail.forEach((k, i) => {
      if (k.endsWith(suffix)) cands.push(availableKeys[i]);
    });

    if (cands.length === 1) {
      push(cands[0]);
    } else if (cands.length > 1) {
      // Heuristik: Pset_SpaceCommon oder Qto_* bevorzugen
      const pref =
        cands.find(k => /(^|\/)Pset_SpaceCommon\./i.test(k)) ||
        cands.find(k => /(^|\/)Qto_/i.test(k)) ||
        cands[0];
      push(pref);
    }
    // keine Treffer -> ignorieren
  }
  return unique;
}

/* --------------------------- Projekt/Storey Lookup -------------------------- */

function buildAggregatesIndex(api: any, modelID: number) {
  const childToParent = new Map<number, number>();
  const vec = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  forEachIdVector(vec, (relId) => {
    const rel = api.GetLine(modelID, relId);
    const parent = rel?.RelatingObject?.value;
    const children = rel?.RelatedObjects ?? [];
    if (!parent || !Array.isArray(children)) return;
    for (const c of children) if (c?.value) childToParent.set(c.value, parent);
  });
  return childToParent;
}

function getNameMapForTypes(api: any, modelID: number, typeConst: number) {
  const m = new Map<number, string>();
  const vec = api.GetLineIDsWithType(modelID, typeConst);
  forEachIdVector(vec, (id) => {
    const line = api.GetLine(modelID, id);
    const nm = toPrimitive(line?.Name);
    if (nm != null) m.set(id, nm);
  });
  return m;
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
  let hops = 0;
  while (cur != null && hops++ < 16) {
    const parent = childToParent.get(cur);
    if (parent == null) break;
    if (!storey && storeyNames.has(parent)) storey = storeyNames.get(parent);
    if (!project && projectNames.has(parent)) project = projectNames.get(parent);
    cur = parent;
  }
  return { storey, project };
}

/* ---------------------- All-Parameters (Pset/Quantities) -------------------- */

function extractPsetProps(api: any, modelID: number, psetLine: any) {
  const out: Record<string, any> = {};
  const pName = toPrimitive(psetLine?.Name) ?? 'Pset';
  const props = psetLine?.HasProperties ?? [];
  for (const p of props) {
    const pid = p?.value; if (!pid) continue;
    const pl = api.GetLine(modelID, pid);
    const nm = toPrimitive(pl?.Name);
    if (!nm) continue;
    const val = toPrimitive(pl?.NominalValue ?? pl?.NominalValue?.value ?? pl?.value);
    out[`${pName}.${nm}`] = val;
  }
  return out;
}

function extractQuantities(api: any, modelID: number, qtoLine: any) {
  const out: Record<string, any> = {};
  const qName = toPrimitive(qtoLine?.Name) ?? 'Qto';
  const quants = qtoLine?.Quantities ?? [];
  for (const q of quants) {
    const qid = q?.value; if (!qid) continue;
    const ql = api.GetLine(modelID, qid);
    const nm = toPrimitive(ql?.Name);
    const area = toPrimitive(ql?.AreaValue);
    const vol  = toPrimitive(ql?.VolumeValue);
    const len  = toPrimitive(ql?.LengthValue ?? ql?.PerimeterValue);
    if (!nm) continue;
    if (area != null) out[`${qName}.${nm}`] = area;
    else if (vol != null) out[`${qName}.${nm}`] = vol;
    else if (len != null) out[`${qName}.${nm}`] = len;
  }
  return out;
}

function buildRelDefinesIndex(api: any, modelID: number) {
  const byRelated = new Map<number, any[]>();
  const vec = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
  forEachIdVector(vec, (relId) => {
    const rel = api.GetLine(modelID, relId);
    const related = rel?.RelatedObjects ?? [];
    const defId = rel?.RelatingPropertyDefinition?.value;
    if (!defId || !Array.isArray(related)) return;
    const defLine = api.GetLine(modelID, defId);
    for (const ro of related) {
      const rid = ro?.value; if (!rid) continue;
      if (!byRelated.has(rid)) byRelated.set(rid, []);
      byRelated.get(rid)!.push(defLine);
    }
  });
  return byRelated;
}

/* ------------------------ Geometrie ohne Mesh/Triangulator ------------------ */
/*   Extrusion + BRep lesen und daraus Area/Volume/Base/Top ableiten           */

/* ---- 2D/3D Geometrie-Helfer ---- */

function polygonArea2D(pts: Array<{ x: number; y: number }>) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x * pts[i].y) - (pts[i].x * pts[j].y);
  }
  return Math.abs(a) * 0.5;
}

function coord3(api: any, modelID: number, cartId: number) {
  const cp = api.GetLine(modelID, cartId);
  const c = cp?.Coordinates ?? [];
  const x = +((c?.[0]?.value) ?? c?.[0] ?? 0);
  const y = +((c?.[1]?.value) ?? c?.[1] ?? 0);
  const z = +((c?.[2]?.value) ?? c?.[2] ?? 0);
  return { x, y, z };
}

function pointsFromPolyLoop(api: any, modelID: number, loopId: number) {
  const pl = api.GetLine(modelID, loopId);
  const pts: Array<{ x: number; y: number; z: number }> = [];
  for (const p of (pl?.Polygon ?? pl?.Points ?? [])) {
    if (p?.value) pts.push(coord3(api, modelID, p.value));
  }
  return pts;
}

function dominantProjectionArea(pts: Array<{x:number;y:number;z:number}>) {
  // Fläche über Projektion auf Ebene mit größter Normal-Komponente
  if (pts.length < 3) return 0;
  // Grobe Normalenabschätzung (Index 0 als Bezug)
  const a = pts[0], b = pts[1], c = pts[2];
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const absNx = Math.abs(nx), absNy = Math.abs(ny), absNz = Math.abs(nz);

  if (absNz >= absNx && absNz >= absNy) {
    // fast horizontal → XY-Projektion
    const xy = pts.map(p => ({ x: p.x, y: p.y }));
    return polygonArea2D(xy);
  } else if (absNy >= absNx && absNy >= absNz) {
    // Projektion auf XZ (wenn Normal am stärksten in Y)
    const xz = pts.map(p => ({ x: p.x, y: p.z }));
    return polygonArea2D(xz);
  } else {
    // Projektion auf YZ
    const yz = pts.map(p => ({ x: p.y, y: p.z }));
    return polygonArea2D(yz);
  }
}

function avgZ(pts: Array<{x:number;y:number;z:number}>) {
  if (!pts.length) return 0;
  return pts.reduce((s,p)=>s+p.z,0)/pts.length;
}

/* ---- ExtrudedAreaSolid ---- */

function areaOfPolylineProfile(api: any, modelID: number, polyId: number) {
  const pl = api.GetLine(modelID, polyId);
  const pts: Array<{ x: number; y: number }> = [];
  for (const p of (pl?.Points ?? pl?.Polygon ?? [])) {
    if (p?.value) {
      const cp = api.GetLine(modelID, p.value);
      const c = cp?.Coordinates ?? [];
      const x = +((c?.[0]?.value) ?? c?.[0] ?? 0);
      const y = +((c?.[1]?.value) ?? c?.[1] ?? 0);
      pts.push({ x, y });
    }
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

function areaOfProfile(api: any, modelID: number, profId: number): number {
  const p = api.GetLine(modelID, profId);
  if (!p) return 0;

  // strukturell prüfen statt nur p.type
  if (p.Points || p.Polygon) return areaOfPolylineProfile(api, modelID, profId);
  if ('XDim' in p && 'YDim' in p) return areaOfRectangleProfile(api, modelID, profId);
  if ('Radius' in p) return areaOfCircleProfile(api, modelID, profId);

  // ArbitraryClosedProfile / CompositeProfile heuristisch zusammensetzen
  if (p.OuterCurve || p.InnerCurves) {
    let A = 0;
    const outer = p.OuterCurve?.value;
    if (outer) {
      const oc = api.GetLine(modelID, outer);
      if (oc?.Points || oc?.Polygon) A += areaOfPolylineProfile(api, modelID, outer);
    }
    const inners = p.InnerCurves ?? [];
    for (const ic of inners) {
      const id = ic?.value;
      if (!id) continue;
      const oc = api.GetLine(modelID, id);
      if (oc?.Points || oc?.Polygon) A -= areaOfPolylineProfile(api, modelID, id);
    }
    return A;
  }

  if (Array.isArray(p.Profiles)) {
    const areas: number[] = [];
    for (const sp of p.Profiles) {
      const sid = sp?.value; if (!sid) continue;
      areas.push(areaOfProfile(api, modelID, sid));
    }
    if (!areas.length) return 0;
    areas.sort((a, b) => b - a);
    return Math.max(0, areas[0] - areas.slice(1).reduce((s,v)=>s+v,0));
  }

  return 0;
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
  const profId = item?.SweptArea?.value;
  const depth  = +((item?.Depth?.value) ?? item?.Depth ?? 0);
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

/* ---- BRep: Faces sammeln, horizontale Grund-/Deckfläche finden ---- */

function facesFromConnectedFaceSet(api: any, modelID: number, cfsId: number): number[] {
  const cfs = api.GetLine(modelID, cfsId);
  const faces = cfs?.CfsFaces ?? cfs?.Faces ?? [];
  const out: number[] = [];
  for (const f of faces) if (f?.value) out.push(f.value);
  return out;
}

function facesFromClosedOrOpenShell(api: any, modelID: number, shellId: number): number[] {
  // IfcClosedShell/IfcOpenShell haben ebenfalls CfsFaces/Faces
  return facesFromConnectedFaceSet(api, modelID, shellId);
}

function outerLoopPointsOfFace(api: any, modelID: number, faceId: number) {
  const face = api.GetLine(modelID, faceId);
  const bounds = face?.Bounds ?? [];
  let best: Array<{x:number;y:number;z:number}> | undefined;
  let bestArea = -1;

  for (const b of bounds) {
    const bid = b?.value; if (!bid) continue;
    const bl = api.GetLine(modelID, bid);
    // Prefer IfcFaceOuterBound, ansonsten größtes Loop mit Orientation=true
    const loopRef = bl?.Bound?.value;
    if (!loopRef) continue;
    const pts = pointsFromPolyLoop(api, modelID, loopRef);
    if (pts.length < 3) continue;
    const area = dominantProjectionArea(pts);
    const isOuter = (bl?.isInner === false) || (bl?.flag === true) || (bl?.Orientation === true) || (bl?.__proto__?.constructor?.name === 'IfcFaceOuterBound');
    // Wähle das größte Loop; Outer bevorzugen
    const score = area * (isOuter ? 10 : 1);
    if (score > bestArea) {
      bestArea = score;
      best = pts;
    }
  }
  return best;
}

function computeFromBrep(api: any, modelID: number, item: any) {
  // Sammle alle Faces (FacetedBrep, FaceBasedSurfaceModel, ShellBasedSurfaceModel)
  const faceIds: number[] = [];

  // IfcFacetedBrep: Outer -> IfcClosedShell
  if (item?.Outer?.value) {
    faceIds.push(...facesFromClosedOrOpenShell(api, modelID, item.Outer.value));
  }

  // IfcFaceBasedSurfaceModel: FbsmFaces[] -> ConnectedFaceSet
  if (Array.isArray(item?.FbsmFaces)) {
    for (const f of item.FbsmFaces) if (f?.value) {
      faceIds.push(...facesFromConnectedFaceSet(api, modelID, f.value));
    }
  }

  // IfcShellBasedSurfaceModel: SbsmBoundary[] -> (Closed/Open)Shell
  const shells = item?.SbsmBoundary ?? item?.Shells ?? item?.Boundary ?? [];
  if (Array.isArray(shells)) {
    for (const s of shells) if (s?.value) {
      faceIds.push(...facesFromClosedOrOpenShell(api, modelID, s.value));
    }
  }

  if (!faceIds.length) return;

  // Horizontal „unten“ und „oben“ bestimmen
  type Cand = { pts: Array<{x:number;y:number;z:number}>, area: number, z: number };
  let base: Cand | undefined;
  let top:  Cand | undefined;

  for (const fid of faceIds) {
    const pts = outerLoopPointsOfFace(api, modelID, fid);
    if (!pts || pts.length < 3) continue;

    // Prüfe Horizontalität: Normal Richtung z
    const a = pts[0], b = pts[1], c = pts[2];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    const nz = (ux * vy - uy * vx);      // z-Komponente der XY-Normalen (schnelle Näherung)
    const horizScore = Math.abs(nz);     // groß ⇒ eher horizontal

    if (horizScore <= 1e-6) continue;

    const area = polygonArea2D(pts.map(p => ({ x: p.x, y: p.y })));
    const z = avgZ(pts);

    const cand: Cand = { pts, area, z };
    if (!base || z < base.z) base = cand;
    if (!top  || z > top.z ) top  = cand;
  }

  if (!base || !top) return;

  const height = Math.max(0, top.z - base.z);
  const A = Math.max(base.area, top.area);
  const V = A * height;

  return { area: A, volume: V, base: base.z, top: top.z };
}

function getFromRepresentation(api: any, modelID: number, spaceId: number) {
  const sp = api.GetLine(modelID, spaceId);
  const rep = sp?.Representation?.value ? api.GetLine(modelID, sp.Representation.value) : null;
  if (!rep || !Array.isArray(rep.Representations)) return;

  let area = 0, volume = 0;
  let base: number | undefined, top: number | undefined;

  for (const r of rep.Representations) {
    const rid = r?.value; if (!rid) continue;
    const sr = api.GetLine(modelID, rid);
    const items = sr?.Items ?? [];
    for (const it of items) {
      const iid = it?.value; if (!iid) continue;
      const item = api.GetLine(modelID, iid);

      // 1) Extrusion
      const ex = computeExtrudedAreaSolid(api, modelID, item);
      if (ex) {
        area += ex.area;
        volume += ex.volume;
        if (ex.base != null) base = (base == null) ? ex.base : Math.min(base, ex.base);
        if (ex.top  != null) top  = (top  == null) ? ex.top  : Math.max(top,  ex.top);
        continue;
      }

      // 2) BRep
      const br = computeFromBrep(api, modelID, item);
      if (br) {
        area += br.area;
        volume += br.volume;
        if (br.base != null) base = (base == null) ? br.base : Math.min(base, br.base);
        if (br.top  != null) top  = (top  == null) ? br.top  : Math.max(top,  br.top);
      }
    }
  }

  if (area > 0 || volume > 0) return { area, volume, base, top };
}

/* --------------------------------- Hauptfunktion --------------------------- */

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const {
    allParams = true,
    useGeometry = true,     // hier: Representation-Fallback
    forceGeometry = false,  // darf Pset/Qto überschreiben
    extraParams = [],
    renameMap,
    round,
  } = opts;

  const api = new IfcAPI();
  await api.Init();
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const childToParent = buildAggregatesIndex(api as any, modelID);
    const storeyNames   = getNameMapForTypes(api as any, modelID, IFCBUILDINGSTOREY);
    const projectNames  = getNameMapForTypes(api as any, modelID, IFCPROJECT);
    // Index jetzt immer bauen – wird auch für gezielte Extra-Parameter gebraucht
    const relDefsByRelated = buildRelDefinesIndex(api as any, modelID);

    const rows: Array<Record<string, any>> = [];
    const spaceVec = api.GetLineIDsWithType(modelID, IFCSPACE);

    forEachIdVector(spaceVec, (id) => {
      const space = api.GetLine(modelID, id);

      const row: Record<string, any> = {
        GlobalId: toPrimitive(space?.GlobalId),
        Name: toPrimitive(space?.Name),
        LongName: toPrimitive(space?.LongName),
        Number: toPrimitive(space?.Tag ?? space?.Number),
      };

      // Kontext
      const { storey, project } = resolveStoreyAndProject(
        childToParent, storeyNames, projectNames, id,
      );
      if (storey) row['Storey'] = storey;
      if (project) row['Project'] = project;

      // ---- Psets / Quantities sammeln (immer in flatProps), optional in row mergen
      const flatProps: Record<string, any> = {};
      const defs = relDefsByRelated.get(id) ?? [];
      for (const def of defs) {
        if (!def?.type) continue;
        if (def.type === IFCPROPERTYSET) {
          const o = extractPsetProps(api as any, modelID, def);
          Object.assign(flatProps, o);
          if (allParams) Object.assign(row, o);
        } else if (def.type === IFCELEMENTQUANTITY) {
          const o = extractQuantities(api as any, modelID, def);
          Object.assign(flatProps, o);
          if (allParams) Object.assign(row, o);
        }
      }

      // Geometrie NUR über Representation (Extrusion/BRep) – kein Mesh / keine Triangulation
      if (useGeometry || forceGeometry) {
        try {
          const rep = getFromRepresentation(api as any, modelID, id);
          if (rep) {
            setIfEmpty(row, 'Area',   roundIf(rep.area, round),   forceGeometry);
            setIfEmpty(row, 'Volume', roundIf(rep.volume, round), forceGeometry);
            if (rep.base != null) setIfEmpty(row, 'Base Elevation', roundIf(rep.base, round));
            if (rep.top  != null) setIfEmpty(row, 'Top Elevation',  roundIf(rep.top,  round));
          }
        } catch {/* best effort */}
      }

      // ------------------------ Extra Parameters anwenden ------------------------
      const tokens = splitExtraParams(extraParams as any);

      // 1) Space.* Direktzugriffe
      for (const t of tokens) {
        if (t.toLowerCase().startsWith('space.')) {
          const k = t.slice('Space.'.length); // Case beibehalten für Ausgabe
          try {
            const v = toPrimitive((space as any)?.[k]);
            if (v != null) row[k] = v;
          } catch {/* noop */}
        }
      }

      // 2) Pset-/Qto-Keys auflösen (mit oder ohne Pset-Angabe)
      const resolved = resolveExtraKeys(tokens, Object.keys(flatProps));
      for (const key of resolved) {
        // erzwinge Aufnahme – auch wenn allParams=false (oder Key bereits existiert)
        setIfEmpty(row, key, flatProps[key], true);
      }
      // --------------------------------------------------------------------------

      if (typeof round === 'number') {
        for (const [k, v] of Object.entries(row)) {
          if (v != null && isFinite(Number(v))) row[k] = roundIf(v, round);
        }
      }

      applyRename(row, renameMap);
      rows.push(row);
    });

    return rows;
  } finally {
    try { api.CloseModel(modelID); } catch {}
  }
}
