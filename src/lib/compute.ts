// src/lib/compute.ts
// Orchestriert Space-Auslese + Area/Volume-Ermittlung inkl. 2D-Fallback.

import type { IfcAPI } from 'web-ifc';
import {
  computeAreaVolumeFrom2D,
} from './spaceMetrics';

export interface ComputeOptions {
  /** Standardhöhe in m, falls keine Storey-Höhe ermittelbar */
  defaultHeight?: number;
  /** optional: XY-Skalierung, falls Einheitenfehler */
  scaleXY?: number;
}

export interface SpaceRow {
  GlobalId?: string;
  Name?: string;
  LongName?: string;
  Number?: string;
  Storey?: string;
  Area?: number;
  Volume?: number;
  [k: string]: any;
}

export async function computeSpaces(
  ifc: IfcAPI,
  modelID: number,
  opts?: ComputeOptions,
): Promise<SpaceRow[]> {
  const rows: SpaceRow[] = [];
  const it = ifc.GetLineIDsWithType(modelID, 'IFCSPACE');

  for (let i = 0; i < it.size(); i++) {
    const id = it.get(i);
    const space = ifc.GetLine(modelID, id);
    const row: SpaceRow = {
      GlobalId: space?.GlobalId || space?.GlobalID || undefined,
      Name: space?.LongName || space?.Name || undefined,
      LongName: space?.LongName || undefined,
      Number: await tryResolveRoomNumber(ifc, modelID, id, space),
      Storey: await tryResolveStoreyName(ifc, modelID, id),
      Area: 0,
      Volume: 0,
    };

    // 1) Falls du bereits eine Mesh-basierte Ermittlung hast, hier aufrufen:
    try {
      const meshResult = await tryYourMeshAreaVolume(ifc, modelID, id);
      if (meshResult) {
        row.Area = meshResult.area ?? 0;
        row.Volume = meshResult.volume ?? 0;
      }
    } catch {
      // Mesh-Berechnung fehlgeschlagen -> egal, Fallback kommt.
    }

    // 2) Falls Area/Volume weiterhin 0 sind → 2D-Fallback
    if (!row.Area || row.Area <= 0 || !row.Volume || row.Volume <= 0) {
      try {
        const { area, volume } = await computeAreaVolumeFrom2D(ifc, modelID, id, {
          defaultHeight: opts?.defaultHeight ?? 2.8,
          scaleXY: opts?.scaleXY ?? 1,
        });
        if (area > 0) row.Area = area;
        if (volume > 0) row.Volume = volume;
      } catch {
        // bleibt 0 – dann ist der Space wirklich nicht auswertbar
      }
    }

    rows.push(row);
  }

  return rows;
}

/* ----------------------------- Helper/Resolver ---------------------------- */

async function tryResolveRoomNumber(ifc: IfcAPI, modelID: number, spaceID: number, spaceObj: any): Promise<string | undefined> {
  // 1) Standardfelder
  if (spaceObj?.Number) return String(spaceObj.Number);

  // 2) Psets (Revit/ArchiCAD)
  const num = await findInPsets(ifc, modelID, spaceID, [
    'Room Number',
    'Number',
    'Mark',
    'Reference',
  ]);
  return num || undefined;
}

async function tryResolveStoreyName(ifc: IfcAPI, modelID: number, spaceID: number): Promise<string | undefined> {
  // über RelContainedInSpatialStructure
  const it = ifc.GetLineIDsWithType(modelID, 'IFCRELCONTAINEDINSPATIALSTRUCTURE');
  for (let i = 0; i < it.size(); i++) {
    const id = it.get(i);
    const rel = ifc.GetLine(modelID, id);
    if (!rel?.RelatingStructure) continue;
    if (!Array.isArray(rel.RelatedElements)) continue;
    if (rel.RelatedElements.includes(spaceID)) {
      const storey = ifc.GetLine(modelID, rel.RelatingStructure);
      return storey?.Name || storey?.LongName || undefined;
    }
  }
  return undefined;
}

async function findInPsets(ifc: IfcAPI, modelID: number, elemID: number, keys: string[]): Promise<string | null> {
  // einfache Suche über IfcRelDefinesByProperties → PropertySets
  const it = ifc.GetLineIDsWithType(modelID, 'IFCRELDEFINESBYPROPERTIES');
  for (let i = 0; i < it.size(); i++) {
    const id = it.get(i);
    const rel = ifc.GetLine(modelID, id);
    if (!Array.isArray(rel?.RelatedObjects) || !rel.RelatingPropertyDefinition) continue;
    if (!rel.RelatedObjects.includes(elemID)) continue;
    const pset = ifc.GetLine(modelID, rel.RelatingPropertyDefinition);
    if (!pset) continue;

    // IfcPropertySet
    if (pset?.HasProperties && Array.isArray(pset.HasProperties)) {
      for (const pID of pset.HasProperties) {
        const p = ifc.GetLine(modelID, pID);
        const name = (p?.Name || '').toString().toLowerCase();
        const wanted = keys.find(k => name === k.toLowerCase());
        if (wanted) {
          const val = p?.NominalValue?.value ?? p?.NominalValue ?? p?.NominalValue?.StringValue ?? p?.NominalValue?.IfcValue;
          if (val != null) return String(val);
        }
      }
    }
  }
  return null;
}

/** Platzhalter – falls du bereits Mesh-Logik hattest, binde sie hier ein. */
async function tryYourMeshAreaVolume(
  _ifc: IfcAPI,
  _modelID: number,
  _spaceID: number,
): Promise<{ area: number; volume: number } | null> {
  // Wenn du nichts Mesh-basiertes nutzt, gib einfach null zurück
  return null;
}
