// src/lib/compute.ts
import {
  IfcAPI,
  // Entities we need:
  IFCPROJECT,
  IFCSPACE,
  IFCBUILDINGSTOREY,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCPROPERTYSET,
  IFCELEMENTQUANTITY,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
  // Property types (2x3/4):
  IFCPROPERTYSINGLEVALUE,
  IFCPROPERTYENUMERATEDVALUE,
  IFCPROPERTYBOUNDEDVALUE,
  IFCPROPERTYLISTVALUE,
} from 'web-ifc';

import { getSpaceAreaVolume } from './mesh-math';

export interface QtoOptions {
  allParams?: boolean;           // alle Psets + Quantities flach ausgeben
  useGeometry?: boolean;         // Pset-Fehlt → Geometrie-Fallback benutzen
  forceGeometry?: boolean;       // immer Geometrie berechnen (überschreibt Pset)
  extraParams?: string[];        // zusätzliche Spaltennamen, die wir erzwingen
  renameMap?: Record<string, string>;
  round?: number;                // Rundung im Node; hier nur als Info
}

// --------- kleine Helfer -----------------------------------------------------

const isArr = (v: any) => Array.isArray(v);

// entpackt IFC Value-Wrapper rekursiv
function unwrap(v: any): any {
  if (v === undefined || v === null) return v;
  if (typeof v === 'object' && 'value' in v && Object.keys(v).length <= 2) {
    return unwrap(v.value);
  }
  return v;
}

function addKV(row: Record<string, any>, key: string, val: any) {
  const v = unwrap(val);
  if (v === undefined || v === null) return;
  row[key] = v;
}

function idsOf(api: any, modelID: number, type: number): number[] {
  const v: any = api.GetLineIDsWithType(modelID, type);
  const out: number[] = [];
  const size = typeof v?.size === 'function' ? v.size() : 0;
  for (let i = 0; i < size; i++) {
    const id = v.get(i);
    if (typeof id === 'number') out.push(id);
  }
  return out;
}

function line(api: any, modelID: number, id: number): any {
  try { return api.GetLine(modelID, id); } catch { return undefined; }
}

// Pset: verschiedene Property-Typen robust lesen
function readIfcPropValue(api: any, modelID: number, propLine: any): any {
  if (!propLine) return undefined;

  if (propLine.type === IFCPROPERTYSINGLEVALUE) {
    return unwrap(propLine.NominalValue);
  }

  if (propLine.type === IFCPROPERTYENUMERATEDVALUE) {
    // Values: array
    const vals = (propLine.EnumerationValues || propLine.Values || []).map((x: any) => unwrap(x));
    return vals.join('; ');
  }

  if (propLine.type === IFCPROPERTYBOUNDEDVALUE) {
    // Lower/Upper/Nominal… – wir geben das Sinnvollste aus
    const lo = unwrap(propLine.LowerBoundValue);
    const hi = unwrap(propLine.UpperBoundValue);
    const nom = unwrap(propLine.NominalValue);
    if (nom !== undefined) return nom;
    if (lo !== undefined || hi !== undefined) return `${lo ?? ''}..${hi ?? ''}`.trim();
    return undefined;
  }

  if (propLine.type === IFCPROPERTYLISTVALUE) {
    const list = (propLine.ListValues || []).map((x: any) => unwrap(x));
    return list.join('; ');
  }

  // Fallback: Name/Description/Value-Felder
  if ('NominalValue' in propLine) return unwrap((propLine as any).NominalValue);
  if ('Value' in propLine) return unwrap((propLine as any).Value);
  return undefined;
}

// Alle PropertySets + ElementQuantities eines Space flach in row schreiben
function collectAllPsetsAndQTO(
  api: any,
  modelID: number,
  spaceID: number,
  row: Record<string, any>,
  onlyQtoAreaVol: boolean
) {
  const relIDs = idsOf(api, modelID, IFCRELDEFINESBYPROPERTIES);
  for (const rid of relIDs) {
    const rel = line(api, modelID, rid);
    const related = rel?.RelatedObjects;
    if (!isArr(related)) continue;
    const isForThis = related.some((o: any) => (o?.value ?? o) === spaceID);
    if (!isForThis) continue;

    const relDef = rel?.RelatingPropertyDefinition;
    const defId = relDef?.value ?? relDef;
    const pd = defId ? line(api, modelID, defId) : undefined;
    if (!pd) continue;

    // ElementQuantities → Area / Volume (und optional detailliert)
    if (pd.type === IFCELEMENTQUANTITY && isArr(pd.Quantities)) {
      const qsetName = unwrap(pd.Name) ?? 'ElementQuantities';
      for (const q of pd.Quantities) {
        const ql = line(api, modelID, q?.value ?? q);
        if (!ql) continue;
        const qn = unwrap(ql.Name) ?? '';

        if (ql.type === IFCQUANTITYAREA) {
          // Hauptspalte
          addKV(row, 'Area', ql.AreaValue);
          if (!onlyQtoAreaVol) addKV(row, `${qsetName}.${qn || 'Area'}`, ql.AreaValue);
        } else if (ql.type === IFCQUANTITYVOLUME) {
          addKV(row, 'Volume', ql.VolumeValue);
          if (!onlyQtoAreaVol) addKV(row, `${qsetName}.${qn || 'Volume'}`, ql.VolumeValue);
        } else if (!onlyQtoAreaVol) {
          // andere Mengen auch mitnehmen
          const val =
            ql.LengthValue ?? ql.CountValue ?? ql.WeightValue ?? ql.TimeValue ?? undefined;
          if (val !== undefined) addKV(row, `${qsetName}.${qn || 'Value'}`, val);
        }
      }
      continue;
    }

    // PropertySet → alle Properties
    if (pd.type === IFCPROPERTYSET && isArr(pd.HasProperties) && !onlyQtoAreaVol) {
      const psetName = unwrap(pd.Name) ?? 'PSet';
      for (const hp of pd.HasProperties) {
        const pl = line(api, modelID, hp?.value ?? hp);
        if (!pl) continue;
        const pn = unwrap(pl.Name) ?? 'Prop';
        const pv = readIfcPropValue(api, modelID, pl);
        if (pv !== undefined) addKV(row, `${psetName}.${pn}`, pv);
      }
    }
  }
}

// storey + elevation auflösen (über RelContainedInSpatialStructure)
function getStoreyInfoForSpace(
  api: any,
  modelID: number,
  spaceID: number
): { name?: string; elevation?: number } {
  const relIDs = idsOf(api, modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (const rid of relIDs) {
    const rel = line(api, modelID, rid);
    const related = rel?.RelatedElements;
    if (!isArr(related)) continue;
    const isThis = related.some((o: any) => (o?.value ?? o) === spaceID);
    if (!isThis) continue;

    const strId = rel?.RelatingStructure?.value ?? rel?.RelatingStructure;
    const storey = strId ? line(api, modelID, strId) : undefined;
    if (storey?.type === IFCBUILDINGSTOREY) {
      return {
        name: unwrap(storey.Name),
        elevation: unwrap(storey.Elevation),
      };
    }
  }
  return {};
}

// Projektname ermitteln
function getProjectName(api: any, modelID: number): string | undefined {
  const pids = idsOf(api, modelID, IFCPROJECT);
  if (!pids.length) return undefined;
  const prj = line(api, modelID, pids[0]);
  return unwrap(prj?.Name) ?? unwrap(prj?.LongName);
}

// ------------------------------ Hauptfunktion --------------------------------

export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const {
    allParams = false,
    useGeometry = false,
    forceGeometry = false,
    extraParams = [],
    renameMap = {},
  } = opts;

  const api: any = new IfcAPI();

  // In Node NICHT SetWasmPath aufrufen!
  await api.Init();

  // WICHTIG: Uint8Array in OpenModel
  const modelID = api.OpenModel(new Uint8Array(buffer));

  try {
    const rows: Array<Record<string, any>> = [];

    const projectName = getProjectName(api, modelID);

    const spaceIDs = idsOf(api, modelID, IFCSPACE);
    for (const sid of spaceIDs) {
      const sp = line(api, modelID, sid);
      if (!sp) continue;

      const row: Record<string, any> = {
        GlobalId: unwrap(sp.GlobalId),
        Name: unwrap(sp.Name),
        LongName: unwrap(sp.LongName),
      };

      if (projectName) row.Project = projectName;

      // Storey + Elevation
      const st = getStoreyInfoForSpace(api, modelID, sid);
      if (st.name) row.Storey = st.name;
      if (st.elevation !== undefined) row['Storey.Elevation'] = st.elevation;

      // QTO/Psets
      collectAllPsetsAndQTO(api, modelID, sid, row, !allParams);

      // --- Geometrie ---
      // Bedingungen:
      // - forceGeometry: immer überschreiben
      // - useGeometry: nur wenn Area/Volume fehlen
      const needGeo =
        forceGeometry ||
        (useGeometry && (row.Area === undefined || row.Volume === undefined));

      if (needGeo) {
        try {
          const geo = getSpaceAreaVolume(api, modelID, sid);
          if (geo && (geo.area !== undefined || geo.volume !== undefined)) {
            if (forceGeometry || row.Area === undefined)   row.Area = geo.area;
            if (forceGeometry || row.Volume === undefined) row.Volume = geo.volume;
          }
        } catch {
          // still ok – wir lassen Pset-Werte stehen
        }
      }

      // extraParams erzwingen (falls noch nicht vorhanden)
      for (const p of extraParams) {
        if (!p) continue;
        if (!(p in row)) row[p] = undefined;
      }

      // Umbenennen
      for (const [oldK, newK] of Object.entries(renameMap)) {
        if (oldK in row) {
          if (newK && newK !== oldK) {
            row[newK] = row[oldK];
            delete row[oldK];
          }
        }
      }

      rows.push(row);
    }

    return rows;
  } finally {
    try { api.CloseModel(modelID); } catch {}
    // KEIN api.Dispose() in manchen Versionen vorhanden
  }
}
