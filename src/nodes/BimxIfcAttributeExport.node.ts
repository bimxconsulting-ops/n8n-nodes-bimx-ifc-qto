// src/nodes/BimxIfcAttributeExport.node.ts
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import * as XLSX from 'xlsx';
import { IfcAPI } from 'web-ifc';
import * as WEBIFC from 'web-ifc';
import { toBuffer } from '../utils/toBuffer';

/* ------------------------------ Helpers ----------------------------------- */

function forEachIdVector(vec: any, cb: (id: number) => void) {
	const size =
		typeof vec?.size === 'function' ? vec.size() :
		Array.isArray(vec) ? vec.length : 0;
	for (let i = 0; i < size; i++) {
		const id = typeof vec?.get === 'function' ? vec.get(i) : vec[i];
		if (id != null) cb(id as number);
	}
}

function vectorSize(vec: any): number {
	return typeof vec?.size === 'function' ? vec.size() : (Array.isArray(vec) ? vec.length : 0);
}

function getVectorFirstIds(vec: any, n = 5): number[] {
	const sz = vectorSize(vec);
	const out: number[] = [];
	for (let i = 0; i < Math.min(n, sz); i++) {
		out.push(typeof vec?.get === 'function' ? vec.get(i) : vec[i]);
	}
	return out;
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

const {
	IFCRELDEFINESBYPROPERTIES,
	IFCPROPERTYSET,
	IFCELEMENTQUANTITY,
	IFCSPACE,
} = WEBIFC as any;

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

/* ------------------------------ Scope/Parsing ------------------------------ */

type Scope = 'spaces' | 'custom' | 'all';

function parseTypeList(list: string): number[] {
	return (list ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((name) => (WEBIFC as any)[name])
		.filter((v): v is number => typeof v === 'number');
}

function getIfcTypeConstantsForScope(scope: Scope, customList: string | undefined, excludeList: string | undefined): number[] {
	const excludeSet = new Set<number>(parseTypeList(excludeList ?? ''));

	if (scope === 'spaces') {
		const types = [IFCSPACE];
		return types.filter((t) => !excludeSet.has(t));
	}
	if (scope === 'custom') {
		const types = parseTypeList(customList ?? '');
		return types.filter((t) => !excludeSet.has(t));
	}

	// scope === 'all' -> alle Entitäten außer IFCREL*, danach Exclude anwenden
	const entries = Object.entries(WEBIFC).filter(([k, v]) => k.startsWith('IFC') && typeof v === 'number');
	const filtered = entries
		.filter(([k]) => !k.startsWith('IFCREL'))
		.map(([, v]) => v as number)
		.filter((t) => !excludeSet.has(t));
	return filtered;
}

/**
 * Prüft heuristisch, ob eine Entität "rooted" ist (IfcRoot-Ableitung)
 * -> besitzt i. d. R. ein GlobalId-Feld.
 */
function isRootedEntitySample(api: any, modelID: number, _typeConst: number, vec: any): boolean {
	const firstIds = getVectorFirstIds(vec, 5);
	for (const id of firstIds) {
		const line = api.GetLine(modelID, id);
		if (line && ('GlobalId' in line)) return true;
	}
	return false;
}

/* -------------------------------- Node ------------------------------------ */

export class BimxIfcAttributeExport implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BIM X - IFC Attribute Export',
		name: 'bimxIfcAttributeExport',
		icon: 'file:BIMX.svg',
		group: ['transform'],
		version: 1,
		description:
			'Exports attributes (Core/Pset/Qto) from IFC as a flat table. JSON for chaining, XLSX for download.',
		defaults: { name: 'BIM X - IFC Attribute Export' },
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
			{
				displayName: 'Entity Scope',
				name: 'entityScope',
				type: 'options',
				options: [
					{ name: 'Spaces only', value: 'spaces' },
					{ name: 'Custom IFC types', value: 'custom' },
					{ name: 'All IFC entities (only types present in the model)', value: 'all' },
				],
				default: 'custom',
			},
			{
				displayName: 'Custom IFC Types',
				name: 'customIfcTypes',
				type: 'string',
				placeholder: 'IFCSPACE,IFCDOOR,IFCWALL',
				default: 'IFCSPACE,IFCDOOR,IFCWALL',
				displayOptions: { show: { entityScope: ['custom'] } },
			},
			{
				displayName: 'Exclude IFC Types',
				name: 'excludeIfcTypes',
				type: 'string',
				placeholder: 'IFCPROPERTYSET,IFCBUILDING,IFCBUILDINGSTOREY,IFCPROJECT',
				default: 'IFCPROPERTYSET,IFCBUILDING,IFCBUILDINGSTOREY,IFCPROJECT',
				description: 'Comma-separated WEB-IFC constants to exclude from export',
			},
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
			const excludeList = this.getNodeParameter('excludeIfcTypes', i, '') as string;
			const rowLayout = this.getNodeParameter('rowLayout', i, 'wide') as 'wide' | 'long';
			const includeCore = this.getNodeParameter('includeCore', i, true) as boolean;
			const wantXlsx = this.getNodeParameter('xlsx', i, false) as boolean;
			const wantJson = this.getNodeParameter('jsonOut', i, true) as boolean;

			const bin = items[i].binary?.[binProp];
			if (!bin?.data) {
				throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" missing`, {
					itemIndex: i,
				});
			}

			const buffer = toBuffer(bin.data);

			const api = new IfcAPI();
			await api.Init();
			const modelID = api.OpenModel(new Uint8Array(buffer));

			try {
				const relIndex = buildRelDefinesIndex(api as any, modelID);
				const candidateTypeIds = getIfcTypeConstantsForScope(scope, customList, excludeList);

				if (!candidateTypeIds.length) {
					throw new NodeOperationError(
						this.getNode(),
						'No IFC types to export (check Entity Scope / Custom / Exclude lists).',
						{ itemIndex: i },
					);
				}

				// Präsenz-Scan + Rooted-Filter: nur Typen mit Instanzen UND GlobalId
				const presentVectors: Array<{ typeConst: number; vec: any }> = [];
				for (const typeConst of candidateTypeIds) {
					const vec = api.GetLineIDsWithType(modelID, typeConst);
					if (vectorSize(vec) === 0) continue;
					if (!isRootedEntitySample(api, modelID, typeConst, vec)) continue;
					presentVectors.push({ typeConst, vec });
				}

				if (!presentVectors.length) {
					const emptyRes: INodeExecutionData = { json: { rows: [], count: 0, rowLayout, scope } };
					out.push(emptyRes);
					continue;
				}

				const wideRows: Array<Record<string, any>> = [];
				const longRows: Array<Record<string, any>> = [];

				for (const { typeConst, vec } of presentVectors) {
					forEachIdVector(vec, (id) => {
						const line = api.GetLine(modelID, id);
						if (!line) return;

						// Fallback-Schutz: einzelne ohne GlobalId überspringen
						if (!('GlobalId' in line)) return;

						const typeName = TYPE_NAME_BY_ID.get(line.type) ?? `IFC#${line.type}`;

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

						let psetCols: Record<string, any> = {};
						const defs = relIndex.get(id) ?? [];
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

				const rows = rowLayout === 'wide' ? wideRows : longRows;

				const result: INodeExecutionData = { json: {}, binary: {} };

				// JSON zur Weiterverarbeitung
				if (wantJson) {
					result.json = {
						rows,
						rowLayout,
						scope,
						count: rows.length,
					};
				} else {
					result.json = { count: rows.length, rowLayout, scope };
				}

				// XLSX als Binary
				if (wantXlsx) {
					const ws = XLSX.utils.json_to_sheet(rows);
					const wb = XLSX.utils.book_new();
					XLSX.utils.book_append_sheet(wb, ws, 'Attributes');
					const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as unknown as Buffer;
					const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
					xbin.fileName = 'ifc_attributes.xlsx';
					xbin.mimeType =
						'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
					(result.binary as any)['xlsx'] = xbin;
				}

				out.push(result);
			} finally {
				try { api.CloseModel(modelID); } catch {}
			}
		}

		return this.prepareOutputData(out);
	}
}
