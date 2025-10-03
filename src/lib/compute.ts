/* eslint-disable @typescript-eslint/no-explicit-any */
import { IfcAPI } from "web-ifc";

// IFC type ids (stabil in web-ifc)
const IFCSPACE = 27; // WebIFC.IFCSpace
const IFCRELDEFINESBYPROPERTIES = 358;
const IFCPROPERTYSINGLEVALUE = 1458870069;
const IFCELEMENTQUANTITY = 3252022860;
const IFCQUANTITYAREA = 2389731845;
const IFCQUANTITYVOLUME = 1697651030;

type Row = {
  GlobalId: string;
  Name?: string | null;
  Area: number | null;
  Volume: number | null;
};

function toNumber(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const withDot = v.replace(",", ".").trim();
    const n = Number(withDot);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && "value" in v) {
    // web-ifc nominal values are often { value: number|string }
    return toNumber((v as any).value);
  }
  return null;
}

function pickFirst(...vals: Array<number | null | undefined>): number | null {
  for (const v of vals) {
    const n = v ?? null;
    if (n !== null) return n;
  }
  return null;
}

async function getAllLines(api: IfcAPI, modelID: number, type: number): Promise<any[]> {
  const ids = await api.GetLineIDsWithType(modelID, type);
  const result: any[] = [];
  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    const line = await api.GetLine(modelID, id, true);
    result.push(line);
  }
  return result;
}

function arrayify<T>(v: T | T[] | undefined | null): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Holt für einen Space die zugewiesenen PropertySets & Quantities
 */
async function collectRelProps(api: IfcAPI, modelID: number, spaceExpressId: number) {
  // Alle IfcRelDefinesByProperties einmal holen und lokal filtern (performant genug für QTO)
  const rels = await getAllLines(api, modelID, IFCRELDEFINESBYPROPERTIES);
  return rels.filter((r) => arrayify(r.RelatedObjects).some((o: any) => o?.value === spaceExpressId));
}

function getPsetValueFromSingleValue(pset: any, wantedName: string): number | null {
  const hasProps = arrayify<any>(pset?.HasProperties);
  for (const p of hasProps) {
    if (p?.type === IFCPROPERTYSINGLEVALUE) {
      const name = p?.Name?.value ?? p?.Name;
      if (typeof name === "string" && name.toLowerCase() === wantedName.toLowerCase()) {
        return toNumber(p?.NominalValue);
      }
    }
  }
  return null;
}

function getQuantityFromElementQuantity(q: any, wantedName: string, wantedType: number): number | null {
  const qs = arrayify<any>(q?.Quantities);
  for (const x of qs) {
    if (x?.type !== wantedType) continue;
    const name = x?.Name?.value ?? x?.Name;
    if (typeof name === "string" && name.toLowerCase() === wantedName.toLowerCase()) {
      return toNumber(x?.AreaValue ?? x?.VolumeValue ?? x?.value);
    }
  }
  return null;
}

/**
 * Liest Area/Volume aus typischen Quellen – ohne Geometrie:
 *  - Qto_SpaceBaseQuantities (IfcElementQuantity -> IfcQuantityArea/Volume)
 *  - PSet_Revit_Dimensions (IfcPropertySingleValue "Area"/"Volume")
 *  - beliebige Psets mit "Area"/"Volume" als SingleValue
 */
async function extractAreaVolume(api: IfcAPI, modelID: number, space: any): Promise<{ area: number | null; volume: number | null; }> {
  const rels = await collectRelProps(api, modelID, space.expressID);

  let areaQto: number | null = null;
  let volumeQto: number | null = null;
  let areaPset: number | null = null;
  let volumePset: number | null = null;

  for (const rel of rels) {
    const prop = rel?.RelatingPropertyDefinition;
    if (!prop) continue;

    // IfcElementQuantity (Qto)
    if (prop.type === IFCELEMENTQUANTITY) {
      const qName = (prop?.Name?.value ?? prop?.Name ?? "").toString().toLowerCase();

      // Standardnamen häufigster Space-QTOs
      if (qName.includes("qto_spacebasequantities") || qName.includes("basequantities") || qName.includes("spacequantities")) {
        areaQto = pickFirst(areaQto, getQuantityFromElementQuantity(prop, "GrossFloorArea", IFCQUANTITYAREA));
        areaQto = pickFirst(areaQto, getQuantityFromElementQuantity(prop, "NetFloorArea", IFCQUANTITYAREA));
        volumeQto = pickFirst(volumeQto, getQuantityFromElementQuantity(prop, "GrossVolume", IFCQUANTITYVOLUME));
        volumeQto = pickFirst(volumeQto, getQuantityFromElementQuantity(prop, "NetVolume", IFCQUANTITYVOLUME));
      } else {
        // generischer Versuch
        areaQto = pickFirst(
          areaQto,
          getQuantityFromElementQuantity(prop, "Area", IFCQUANTITYAREA),
          getQuantityFromElementQuantity(prop, "FloorArea", IFCQUANTITYAREA)
        );
        volumeQto = pickFirst(
          volumeQto,
          getQuantityFromElementQuantity(prop, "Volume", IFCQUANTITYVOLUME)
        );
      }
    }

    // IfcPropertySet mit SingleValues
    const psetName = (prop?.Name?.value ?? prop?.Name ?? "").toString().toLowerCase();
    if (prop?.HasProperties) {
      // Revit-Set
      if (psetName.includes("revit") && psetName.includes("dimensions")) {
        areaPset = pickFirst(areaPset, getPsetValueFromSingleValue(prop, "Area"));
        volumePset = pickFirst(volumePset, getPsetValueFromSingleValue(prop, "Volume"));
      } else {
        // generisch
        areaPset = pickFirst(areaPset, getPsetValueFromSingleValue(prop, "Area"));
        volumePset = pickFirst(volumePset, getPsetValueFromSingleValue(prop, "Volume"));
      }
    }
  }

  return {
    area: pickFirst(areaQto, areaPset),
    volume: pickFirst(volumeQto, volumePset),
  };
}

/**
 * Lädt ein IFC aus einem Buffer, iteriert IfcSpace und liefert (GlobalId, Name, Area, Volume).
 * Es werden ausschließlich Psets/Quantities ausgewertet – keine Geometrie-Berechnung.
 */
export async function runQtoOnIFC(buffer: Buffer): Promise<Row[]> {
  const api = new IfcAPI();
  await api.Init();

  // model öffnen
  const modelID = api.OpenModel(buffer);

  try {
    const spaces = await getAllLines(api, modelID, IFCSPACE);

    const rows: Row[] = [];
    for (const s of spaces) {
      const gid = (s?.GlobalId?.value ?? s?.GlobalId ?? "").toString();
      const name = (s?.Name?.value ?? s?.Name ?? null) as string | null;

      const { area, volume } = await extractAreaVolume(api, modelID, s);

      rows.push({
        GlobalId: gid,
        Name: name,
        Area: area,
        Volume: volume,
      });
    }
    return rows;
  } finally {
    api.CloseModel(modelID);
  }
}
