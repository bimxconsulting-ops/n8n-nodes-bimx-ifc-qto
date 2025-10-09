// src/lib/compute.ts

import {
  IfcAPI,
  IFCSPACE,
  IFCRELDEFINESBYPROPERTIES,
  IFCELEMENTQUANTITY,
  IFCQUANTITYAREA,
  IFCQUANTITYVOLUME,
} from 'web-ifc';

/** Optionen aus dem Node */
export interface QtoOptions {
  /** Alle verfügbaren Parameter (direkte Attribute + Psets) aufnehmen */
  allParams?: boolean;
  /** Falls QTO fehlt: Flächen/Volumen aus Geometrie berechnen (wenn möglich) */
  useGeometry?: boolean;
  /** Geometrie immer erzwingen (ignoriert QTO) */
  forceGeometry?: boolean;
  /** Zusätzliche, gezielt gewünschte Attribute/Parameter (Keys) */
  extraParams?: string[];
  /** Mapping: eingelesener Key -> neuer Name */
  renameMap?: Record<string, string>;
  /** Rundung (wird i.d.R. im Node angewendet, hier optional nicht genutzt) */
  round?: number;
}

/* ----------------------------- Hilfsfunktionen ---------------------------- */

function unwrap(v: any): any {
  // web-ifc verpackt Skalarwerte meist in { value: ... }
  if (v && typeof v === 'object' && 'value' in v) return v.value;
  return v;
}

function addIfScalar(target: Record<string, any>, key: string, val: any) {
  const u = unwrap(val);
  const t = typeof u;
  if (u === undefined || u === null) return;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    // keine Überschreibung erzwingen
    if (!(key in target)) target[key] = u;
  }
}

/** Flacht IfcPropertySingleValue / Quantity-Objekte defensiv auf Key->Value ab */
function flattenPropertyLine(line: any): Record<string, any> {
  const out: Record<string, any> = {};

  // Nützliche, typisch vorkommende Felder
  addIfScalar(out, 'Name', line?.Name);
  addIfScalar(out, 'Description', line?.Description);

  // Quantities: <Something>Value
  for (const k of Object.keys(line || {})) {
    if (k.endsWith('Value')) addIfScalar(out, k, line[k]);
  }

  // SingleValue: NominalValue
  if ('NominalValue' in (line || {})) addIfScalar(out, 'NominalValue', line.NominalValue);

  return out;
}

/** Wendet Rename-Mapping auf eine Ergebniszeile an */
function applyRename(row: Record<string, any>, renameMap?: Record<string, string>) {
  if (!renameMap) return;
  for (const [from, to] of Object.entries(renameMap)) {
    if (from in row) {
      row[to] = row[from];
      if (to !== from) delete row[from];
    }
  }
}

/* ------------------------------- Hauptlogik ------------------------------- */

/**
 * Liest IfcSpaces und baut pro Space eine flache Zeile mit Daten:
 * - Basis: GlobalId, Name, LongName
 * - QTO: Area, Volume (aus IfcElementQuantity, sofern vorhanden)
 * - Optional weitere/alle Parameter (direkte Attribute + Psets)
 * - Optional Rename-Mapping
 *
 * Geometrie-Fallback ist als Hook vorgesehen, standardmäßig inaktiv, damit
 * keine Build-/Laufzeit-Abhängigkeiten nötig sind.
 */
export async function runQtoOnIFC(buffer: Buffer, opts: QtoOptions = {}) {
  const api = new IfcAPI();

  // In Node KEIN SetWasmPath — web-ifc findet web-ifc-node.wasm selbst
  await api.Init();

  // Wichtig: Uint8Array übergeben
  const modelID = api.OpenModel(new Uint8Array(buffer));

  const {
    allParams = false,
    extraParams = [],
    useGeometry = false,
    forceGeometry = false,
    renameMap,
  } = opts;

  try {
    const rows: Array<Record<string, any>> = [];

    // Alle Spaces einsammeln
    const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
    const it = ids[Symbol.iterator]();

    for (let step = it.next(); !step.done; step = it.next()) {
      const expressID = step.value as number;
      const space = api.GetLine(modelID, expressID);

      // Basiszeile
      const row: Record<string, any> = {
        GlobalId: unwrap(space?.GlobalId) ?? '',
        Name: unwrap(space?.Name) ?? '',
        LongName: unwrap(space?.LongName) ?? '',
        ExpressID: expressID,
      };

      // ------------------ direkte Attribute (optional) ------------------
      // Wenn allParams aktiv ist, nehmen wir alle skalaren Toplevel-Felder mit.
      if (allParams || extraParams.length) {
        for (const [k, v] of Object.entries(space || {})) {
          if (k === 'type') continue; // interne Typnummer
          addIfScalar(row, k, v);
        }
      }

      // ----------------- Psets / ElementQuantities lesen ----------------
      // Suche alle RelDefinesByProperties, die diesen Space referenzieren.
      const relIDs = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
      const relIt = relIDs[Symbol.iterator]();

      for (let r = relIt.next(); !r.done; r = relIt.next()) {
        const rid = r.value as number;
        const rel = api.GetLine(modelID, rid);

        const related = rel?.RelatedObjects || [];
        if (!Array.isArray(related)) continue;
        if (!related.some((o: any) => unwrap(o) === expressID)) continue;

        const def = rel?.RelatingPropertyDefinition;
        const defId = unwrap(def);
        if (!defId) continue;

        const pdef = api.GetLine(modelID, defId);

        // IfcElementQuantity → Area / Volume + sonstige Quantities
        if (pdef?.type === IFCELEMENTQUANTITY && Array.isArray(pdef?.Quantities)) {
          for (const q of pdef.Quantities) {
            const qLine = api.GetLine(modelID, unwrap(q));
            if (!qLine) continue;

            if (qLine.type === IFCQUANTITYAREA) {
              const av = unwrap(qLine.AreaValue);
              if (typeof av === 'number') row.Area = av;
            } else if (qLine.type === IFCQUANTITYVOLUME) {
              const vv = unwrap(qLine.VolumeValue);
              if (typeof vv === 'number') row.Volume = vv;
            }

            // Bei allParams zusätzlich alle bekannten Felder dieser Quantity mitnehmen
            if (allParams) {
              const flat = flattenPropertyLine(qLine);
              for (const [k, v] of Object.entries(flat)) addIfScalar(row, k, v);
            }
          }
        }

        // IfcPropertySet → Properties (SingleValue etc.)
        if (Array.isArray(pdef?.Properties)) {
          for (const p of pdef.Properties) {
            const pline = api.GetLine(modelID, unwrap(p));
            if (!pline) continue;

            const flat = flattenPropertyLine(pline);

            // typischerweise ist 'Name' der Parametername
            const pname = String(flat.Name ?? '').trim();
            const pval =
              flat.NominalValue ??
              flat.AreaValue ??
              flat.VolumeValue ??
              // irgendein *Value falls vorhanden
              Object.entries(flat).find(([k]) => k.endsWith('Value'))?.[1];

            if (pname && (allParams || extraParams.includes(pname))) {
              addIfScalar(row, pname, pval);
            } else if (allParams) {
              // falls kein Name, trotzdem alle scalars aus flat übernehmen
              for (const [k, v] of Object.entries(flat)) addIfScalar(row, k, v);
            }
          }
        }
      }

      // -------------------- Geometrie-Fallback (optional) --------------------
      // Hook: Nur ausführen, wenn gewünscht.
      if (forceGeometry || (useGeometry && (row.Area == null || row.Volume == null))) {
        try {
          // Dynamischer Import, damit keine harte Build-Abhängigkeit besteht,
          // falls du den Mesh-Teil separat pflegst.
          // Erwartet: getSpaceAreaVolume(api, modelID, expressID) -> { area?: number, volume?: number }
          // Du kannst diese Funktion in src/lib/mesh-math.ts bereitstellen.
          const math = await import('./mesh-math').catch(() => null as any);
          if (math?.getSpaceAreaVolume) {
            const geo = await math.getSpaceAreaVolume(api, modelID, expressID);
            if (geo) {
              if (geo.area != null) row.Area = geo.area;
              if (geo.volume != null) row.Volume = geo.volume;
            }
          } else {
            // kein Mesh-Modul verfügbar – still durchlaufen
          }
        } catch {
          // Geometrie-Fallback fehlgeschlagen, Werte bleiben wie sie sind
        }
      }

      // ------------------------------- Rename -------------------------------
      applyRename(row, renameMap);

      rows.push(row);
    }

    return rows;
  } finally {
    api.CloseModel(modelID);
    api.Dispose();
  }
}
