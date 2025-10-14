// src/lib/extract.ts
import {
  IFCRELDEFINESBYPROPERTIES,
  IFCPROPERTYSET,
  IFCELEMENTQUANTITY,
} from 'web-ifc';

type LineGetter = (modelID: number, id: number) => any;
type VecGetter = (modelID: number, type: number) => any;

export function toPrimitive(val: any): any {
  let v = val;
  while (v && typeof v === 'object' && 'value' in v && Object.keys(v).length === 1) v = v.value;
  if (v && typeof v === 'object' && 'value' in v && typeof v.value !== 'object') v = v.value;
  return v;
}

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

export function buildRelDefinesIndex(api: any, modelID: number) {
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

export function extractPsetProps(api: any, modelID: number, psetLine: any) {
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

export function extractQuantities(api: any, modelID: number, qtoLine: any) {
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

export function extractAllForElement(
  api: any,
  modelID: number,
  elemId: number,
  includeCoreAttrs = true,
  mode: 'wide'|'long' = 'wide',
) {
  const el = api.GetLine(modelID, elemId);
  const cls = el?.__proto__?.constructor?.name || el?.constructor?.name || 'IfcElement';
  const base = {
    GlobalId: toPrimitive(el?.GlobalId),
    Class: cls,
    Name: toPrimitive(el?.Name),
    Description: toPrimitive(el?.Description),
    Tag: toPrimitive(el?.Tag),
  };

  // Psets + Qto
  const byRelated = buildRelDefinesIndex(api, modelID);
  const defs = byRelated.get(elemId) ?? [];

  const bag: Record<string, any> = {};
  for (const def of defs) {
    if (def?.type === IFCPROPERTYSET) Object.assign(bag, extractPsetProps(api, modelID, def));
    else if (def?.type === IFCELEMENTQUANTITY) Object.assign(bag, extractQuantities(api, modelID, def));
  }

  if (mode === 'wide') {
    return [{ ...base, ...(includeCoreAttrs ? {} : { GlobalId: base.GlobalId, Class: base.Class }), ...bag }];
  }

  // long/tidy: eine Zeile pro Key
  const rows: Array<Record<string, any>> = [];
  const core = includeCoreAttrs ? base : { GlobalId: base.GlobalId, Class: base.Class };
  Object.entries(bag).forEach(([key, value]) => {
    rows.push({ ...core, Key: key, Value: value });
  });
  return rows;
}
