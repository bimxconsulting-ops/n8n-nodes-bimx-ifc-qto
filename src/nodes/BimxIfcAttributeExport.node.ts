// src/nodes/BimxIfcAttributeExport.node.ts
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import * as XLSX from 'xlsx';

// Wir brauchen IfcAPI für das Model-Handling und das gesamte WEBIFC-Enum für Typ-Konstanten
import { IfcAPI } from 'web-ifc';
import * as WEBIFC from 'web-ifc';

// gleiches Icon wie beim Space-QTO
// (wird im Build per copy-assets.cjs nach dist/nodes kopiert)
import { toBuffer } from '../utils/toBuffer';

// ----------------------------- kleine Utils ---------------------------------

function forEachIdVector(vec: any, cb: (id: number) => void) {
	const size = typeof vec?.size === 'function' ? vec.size() : Array.isArray(vec) ? vec.length : 0;
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

const TYPE_NAME_BY_ID = new Map<number, string>(
	Object.entries(WEBIFC)
		.filter(([k, v]) => k.startsWith('IFC') && typeof v === 'number')
		.map(([k, v]) => [v as number, k]),
);

// ---------------------- Psets / Quantities aus RelDefines --------------------

const { IFCRELDEFINESBYPROPERTIES, IFCPROPERTYSET, IFCELEMENTQUANTITY } = WEBIFC as any;

function buildRelDefinesIndex(api: any, modelID: number) {
	const byRelated = new Map<number, any[]>();
	const vec = api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
	forEachIdVector(vec, (relId) => {
		const rel = api.GetLine(modelID, relId);
		const related = rel?.RelatedObjects ?? [];
		const defId = rel?.RelatingPropertyDefinition?.value;
		if (!defId) return;
		const def = api.GetLine(modelID, defId);
		for (const ro of related) {
			const rid = ro?.value;
			if (!rid) continue;
			if (!byRelated.has(rid)) byRelated.set(rid, []);
			byRelated.get(rid)!.push(def);
		}
	});
	return byRelated;
}

function extractPsetProps(api: any, modelID: number, psetLine: any) {
	const out: Record<string, any> = {};
	const pName = toPrimitive(psetLine?.Name) ?? 'Pset';
	for (const p of psetLine?.HasProperties ?? []) {
		const pid = p?.value;
		if (!pid) continue;
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
	for (const q of qtoLine?.Quantities ?? []) {
		const qid = q?.value;
		if (!qid) continue;
		const ql = api.GetLine(modelID, qid);
		const nm = toPrimitive(ql?.Name);
		const area = toPrimitive(ql?.AreaValue);
		const vol = toPrimitive(ql?.VolumeValue);
		const len = toPrimitive(ql?.LengthValue ?? ql?.PerimeterValue);
		if (!nm) continue;
		out[`${qName}.${nm}`] = area ?? vol ?? len ?? null;
	}
	return out;
}

// -------------------------- Typauswahl (Scope) -------------------------------

type Scope = 'spaces' | 'custom' | 'all';

function parseCustomTypeList(list: string): number[] {
	const names = (list ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const ids: number[] = [];
	for (const n of names) {
		const v = (WEBIFC as any)[n];
		if (typeof v === 'number') ids.push(v);
	}
	return ids;
}

/**
 * Liefert die Liste von IFC Typ-IDs je nach Auswahl.
 * Bei "all" werden IFCREL* standardmäßig ausgelassen, damit keine reinen Beziehungszeilen exportiert werden.
 */
function getIfcTypeConstantsForScope(scope: Scope, customList?: string): number[] {
	if (scope === 'spaces') return [(WEBIFC as any).IFCSPACE];

	if (scope === 'custom') {
		return parseCustomTypeList(customList ?? '');
	}

	// scope === 'all'
	const all = Object.entries(WEBIFC)
		.filter(([k, v]) => k.startsWith('IFC') && typeof v === 'number')
		.map(([, v]) => v as number);

	// Relationen meist nicht erwünscht
	const relPrefix = new Set(['IFCREL']);
	const filtered = Object.entries(WEBIFC)
		.filter(([k, v]) => k.startsWith('IFC') && typeof v === 'number')
		.filter(([k]) => !relPrefix.has(k.substring(0, 6)))
		.map(([, v]) => v as number);

	// Wenn gefiltert leer sein sollte, fallback auf all
	return filtered.length ? filtered : all;
}

// ------------------------------- Node ----------------------------------------

export class BimxIfcAttributeExport implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BIM X – IFC Attribute Export',
		name: 'bimxIfcAttributeExport',
		icon: 'file:BIMX.svg',
		group: ['transform'],
		version: 1,
		description:
			'Exports attributes (Space/Pset/Qto/Core) from IFC as a flat table (XLSX or JSON). No geometry.',
		defaults: { name: 'BIM X – IFC Attribute Export' },
		inputs: ['main'],
		outputs: ['main'],
		properties: [
			{
				displayName: 'Binary Property',
				name: 'binaryProperty',
				type: 'string',
				default: 'data',
				description: 'Name of the binary property that contains the IFC file',
			},
			// ------------------- Scope -------------------
			{
				displayName: 'Entity Scope',
				name: 'entityScope',
				type: 'options',
				options: [
					{ name: 'Spaces only', value: 'spaces' },
					{ name: 'Custom IFC types', value: 'custom' },
					{ name: 'All IFC entities', value: 'all' },
				],
				default: 'custom',
			},
			{
				displayName: 'Custom IFC Types',
				name: 'customIfcTypes',
				type: 'string',
				placeholder: 'IFCSPACE,IFCWALL,IFCDOOR,...',
				default: 'IFCSPACE',
				displayOptions: { show: { entityScope: ['custom'] } },
			},
			// ------------------- Layout -------------------
			{
				displayName: 'Row Layout',
				name: 'rowLayout',
				type: 'options',
				options: [
					{ name: 'Wide (one row per element)', value: 'wide' },
					{ name: 'Long (key-value rows)', value: 'long' },
				],
				default: 'wide',
			},
			{
				displayName: 'Include Core Attributes (Name, Description, Tag)',
				name: 'includeCore',
				type: 'boolean',
				default: true,
			},
			// ------------------- Outputs -------------------
			{ displayName: 'Generate XLSX', name: 'xlsx', type: 'boolean', default: false },
			{ displayName: 'Generate JSON', name: 'jsonOut', type: 'boolean', default: true },
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const binProp = this.getNodeParameter('binaryProperty', i) as string;
			const scope = this.getNodeParameter('entityScope', i, 'custom') as Scope;
			const customList = this.getNodeParameter('customIfcTypes', i, '') as string;
			const rowLayout = this.getNodeParameter('rowLayout', i, 'wide') as 'wide' | 'long';
			const includeCore = this.getNodeParameter('includeCore', i, true) as boolean;
			const wantXlsx = this.getNodeParameter('xlsx', i, false) as boolean;
			const wantJson = this.getNodeParameter('jsonOut', i, true) as boolean;

			const bin = items[i].binary?.[binProp];
			if (!bin?.data) {
				throw new NodeOperationError(
					this.getNode(),
					`Binary property "${binProp}" missing`,
					{ itemIndex: i },
				);
			}

			const buffer = toBuffer(bin.data);

			const api = new IfcAPI();
			await api.Init();
			const modelID = api.OpenModel(new Uint8Array(buffer));

			try {
				// Indexe
				const relIndex = buildRelDefinesIndex(api as any, modelID);

				// Typen für Scope bestimmen
				const typeIds = getIfcTypeConstantsForScope(scope, customList);
				if (!typeIds.length) {
					throw new NodeOperationError(
						this.getNode(),
						'No IFC types to export (check Entity Scope / Custom IFC Types).',
						{ itemIndex: i },
					);
				}

				// Sammel-Tabellen
				const wideRows: Array<Record<string, any>> = [];
				const longRows: Array<Record<string, any>> = [];

				for (const typeConst of typeIds) {
					const vec = api.GetLineIDsWithType(modelID, typeConst);
					forEachIdVector(vec, (id) => {
						const line = api.GetLine(modelID, id);
						if (!line) return;

						const typeName = TYPE_NAME_BY_ID.get(line.type) ?? `IFC#${line.type}`;

						// Basiszeile
						const base: Record<string, any> = {
							ExpressID: id,
							Type: typeName,
						};

						if (includeCore) {
							base['GlobalId'] = toPrimitive(line?.GlobalId);
							base['Name'] = toPrimitive(line?.Name);
							base['Description'] = toPrimitive(line?.Description);
							base['ObjectType'] = toPrimitive(line?.ObjectType);
							base['Tag'] = toPrimitive(line?.Tag ?? line?.Number);
						}

						// Psets & Quantities
						const defs = relIndex.get(id) ?? [];
						let psetCols: Record<string, any> = {};
						for (const def of defs) {
							if (def?.type === IFCPROPERTYSET) {
								psetCols = { ...psetCols, ...extractPsetProps(api as any, modelID, def) };
							} else if (def?.type === IFCELEMENTQUANTITY) {
								psetCols = { ...psetCols, ...extractQuantities(api as any, modelID, def) };
							}
						}

						if (rowLayout === 'wide') {
							wideRows.push({ ...base, ...psetCols });
						} else {
							// Long-Form: key-value je Paar
							if (includeCore) {
								for (const k of ['GlobalId', 'Name', 'Description', 'ObjectType', 'Tag']) {
									if (base[k] !== undefined) {
										longRows.push({
											ExpressID: id,
											Type: typeName,
											key: `Core.${k}`,
											value: base[k],
										});
									}
								}
							}
							for (const [k, v] of Object.entries(psetCols)) {
								longRows.push({
									ExpressID: id,
									Type: typeName,
									key: k,
									value: v,
								});
							}
						}
					});
				}

				// -------- Ausgabe vorbereiten --------
				const resultItem: INodeExecutionData = { json: {}, binary: {} };

				if (rowLayout === 'wide') {
					resultItem.json = { count: wideRows.length };
				} else {
					resultItem.json = { count: longRows.length };
				}

				// XLSX
				if (wantXlsx) {
					const sheetData = rowLayout === 'wide' ? wideRows : longRows;
					const ws = XLSX.utils.json_to_sheet(sheetData);
					const wb = XLSX.utils.book_new();
					XLSX.utils.book_append_sheet(wb, ws, 'Attributes');
					const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;

					const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
					xbin.fileName = 'ifc_attributes.xlsx';
					xbin.mimeType =
						'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
					(resultItem.binary as any)['xlsx'] = xbin;
				}

				// JSON (als Datei im Binary – einfacher für Weitergabe/Download)
				if (wantJson) {
					const jsonPayload = rowLayout === 'wide' ? wideRows : longRows;
					const jbin = await this.helpers.prepareBinaryData(
						Buffer.from(JSON.stringify(jsonPayload, null, 2), 'utf8'),
					);
					jbin.fileName = 'ifc_attributes.json';
					jbin.mimeType = 'application/json';
					(resultItem.binary as any)['json'] = jbin;
				}

				out.push(resultItem);
			} finally {
				try {
					api.CloseModel(modelID);
				} catch {}
			}
		}

		return this.prepareOutputData(out);
	}
}
