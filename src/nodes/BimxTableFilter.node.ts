// src/nodes/BimxTableFilter.node.ts
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';

// n8n Types
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

// exceljs als CommonJS (stabil in CJS-Builds)
const ExcelJS = require('exceljs');

/** ---------------------- Filter-Engine ---------------------- **/
type Logic = 'AND' | 'OR';
type Op =
	| 'eq'
	| 'neq'
	| 'contains'
	| 'notContains'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'regex';

interface FilterRule {
	field: string;
	op: Op;
	value: any;
}

const asNum = (v: unknown) => {
	const n =
		typeof v === 'number'
			? v
			: parseFloat(String(v).replace(',', '.'));
	return Number.isFinite(n) ? n : undefined;
};

function compileRules(rules: FilterRule[]) {
	return rules.map((r) =>
		r.op === 'regex'
			? {
					...r,
					_re: (() => {
						const m = String(r.value).match(
							/^\/(.*)\/([gimsuy]*)$/,
						);
						const [pat, flags] = m
							? [m[1], m[2]]
							: [String(r.value), 'i'];
						return new RegExp(pat, flags);
					})(),
			  }
			: r,
	) as (FilterRule & { _re?: RegExp })[];
}

function rowMatches(
	row: Record<string, any>,
	rules: (FilterRule & { _re?: RegExp })[],
	logic: Logic,
): boolean {
	const evalRule = (r: FilterRule & { _re?: RegExp }) => {
		const v = row[r.field];

		switch (r.op) {
			case 'eq':
				return String(v) === String(r.value);
			case 'neq':
				return String(v) !== String(r.value);
			case 'contains':
				return String(v ?? '').includes(
					String(r.value ?? ''),
				);
			case 'notContains':
				return !String(v ?? '').includes(
					String(r.value ?? ''),
				);
			case 'gt': {
				const a = asNum(v),
					b = asNum(r.value);
				return (
					a !== undefined &&
					b !== undefined &&
					a > b
				);
			}
			case 'gte': {
				const a = asNum(v),
					b = asNum(r.value);
				return (
					a !== undefined &&
					b !== undefined &&
					a >= b
				);
			}
			case 'lt': {
				const a = asNum(v),
					b = asNum(r.value);
				return (
					a !== undefined &&
					b !== undefined &&
					a < b
				);
			}
			case 'lte': {
				const a = asNum(v),
					b = asNum(r.value);
				return (
					a !== undefined &&
					b !== undefined &&
					a <= b
				);
			}
			case 'regex':
				return r._re!.test(String(v ?? ''));
			default:
				return false;
		}
	};

	if (rules.length === 0) return true;
	if (logic === 'AND') return rules.every(evalRule);
	return rules.some(evalRule);
}

/**
 * Filtert ein XLSX (Buffer) chunked und schreibt ein neues XLSX als Stream.
 */
export async function filterExcelToXlsxStream(
	xlsxBuffer: Buffer,
	sheetNameOrIndex: string | number | undefined,
	rules: FilterRule[],
	logic: Logic = 'AND',
	wantedColumns?: string[],
	chunkSize = 5000,
): Promise<{
	xlsxPath: string;
	outRows: number;
	headers: string[];
}> {
	const wbIn = XLSX.read(xlsxBuffer, { type: 'buffer' });

	const sheetName =
		typeof sheetNameOrIndex === 'number'
			? wbIn.SheetNames[sheetNameOrIndex] ??
			  wbIn.SheetNames[0]
			: sheetNameOrIndex || wbIn.SheetNames[0];

	const wsIn = wbIn.Sheets[sheetName];
	if (!wsIn)
		throw new Error(
			`Sheet "${sheetName}" nicht gefunden.`,
		);

	const ref =
		wsIn['!ref'] ||
		XLSX.utils.encode_range(
			(wsIn['!range'] as any) ?? {
				s: { r: 0, c: 0 },
				e: { r: 0, c: 0 },
			},
		);
	const range = XLSX.utils.decode_range(ref);

	const headerRow = XLSX.utils.sheet_to_json(wsIn, {
		header: 1,
		range: {
			s: { r: range.s.r, c: range.s.c },
			e: { r: range.s.r, c: range.e.c },
		},
		raw: true,
	}) as any[][];
	const allHeaders = (headerRow[0] ?? []).map(String);

	const headers =
		wantedColumns && wantedColumns.length
			? allHeaders.filter((h) =>
					wantedColumns.includes(h),
			  )
			: allHeaders;

	const compiled = compileRules(rules);

	const outPath = path.join(
		os.tmpdir(),
		`bimx-filter-${Date.now()}.xlsx`,
	);
	const wbOut =
		new ExcelJS.stream.xlsx.WorkbookWriter({
			filename: outPath,
			useStyles: false,
			useSharedStrings: false,
		});
	const wsOut =
		wbOut.addWorksheet(sheetName || 'Filtered');

	wsOut.addRow(headers).commit();

	let outRows = 0;
	let start = range.s.r + 1;
	const last = range.e.r;

	while (start <= last) {
		const end = Math.min(
			start + chunkSize - 1,
			last,
		);

		const block =
			XLSX.utils.sheet_to_json<Record<string, any>>(
				wsIn,
				{
					header: allHeaders,
					range: {
						s: {
							r: start,
							c: range.s.c,
						},
						e: {
							r: end,
							c: range.e.c,
						},
					},
					raw: true,
					defval: '',
					blankrows: false,
				},
			);

		for (const row of block) {
			if (
				!row ||
				Object.keys(row).length === 0
			)
				continue;
			if (
				rowMatches(
					row,
					compiled,
					logic,
				)
			) {
				const out = headers.map(
					(h) => row[h] ?? '',
				);
				wsOut.addRow(out).commit();
				outRows++;
			}
		}

		start = end + 1;
		(global as any).gc?.();
	}

	await wbOut.commit();
	return { xlsxPath: outPath, outRows, headers };
}
/** ---------------------- Ende Filter-Engine ---------------------- **/

/** ---------------------- n8n Node-Klasse ---------------------- **/
export class BimxTableFilter implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BIMX Table Filter',
		name: 'bimxTableFilter',
		group: ['transform'],
		version: 1,
		description:
			'Filtert große Excel-Dateien speicherschonend und gibt ein gefiltertes XLSX aus',
		defaults: {
			name: 'BIMX Table Filter',
		},
		inputs: ['main'],
		outputs: ['main'],
		icon: 'file:BIMX.svg',
		properties: [
			{
				displayName: 'Binary Property',
				name: 'binaryProperty',
				type: 'string',
				default: 'xlsx',
				description:
					'Name der Binär-Property, die die Eingabe-XLSX enthält (z. B. "xlsx", "file", "data")',
			},
			{
				displayName: 'Sheet',
				name: 'sheet',
				type: 'string',
				default: '',
				placeholder:
					'Sheet-Name oder Index (0)',
				description:
					'Optional: Blattname oder Index; leer = erstes Blatt',
			},
			{
				displayName: 'Rules',
				name: 'rules',
				type: 'fixedCollection',
				typeOptions: {
					multipleValues: true,
				},
				default: {},
				options: [
					{
						name: 'rule',
						displayName: 'Rule',
						values: [
							{
								displayName: 'Field',
								name: 'field',
								type: 'string',
								default: '',
							},
							{
								displayName:
									'Operator',
								name: 'op',
								type: 'options',
								options: [
									{
										name: 'Equals',
										value: 'eq',
									},
									{
										name: 'Not Equals',
										value: 'neq',
									},
									{
										name: 'Contains',
										value:
											'contains',
									},
									{
										name: 'Not Contains',
										value:
											'notContains',
									},
									{
										name: 'Greater Than',
										value: 'gt',
									},
									{
										name: 'Greater or Equal',
										value: 'gte',
									},
									{
										name: 'Less Than',
										value: 'lt',
									},
									{
										name: 'Less or Equal',
										value: 'lte',
									},
									{
										name: 'Regex',
										value:
											'regex',
									},
								],
								default: 'eq',
							},
							{
								displayName:
									'Value',
								name: 'value',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Logic',
				name: 'logic',
				type: 'options',
				options: [
					{
						name: 'AND',
						value: 'AND',
					},
					{
						name: 'OR',
						value: 'OR',
					},
				],
				default: 'AND',
			},
			{
				displayName:
					'Output Columns',
				name: 'columns',
				type: 'string',
				default: '',
				placeholder:
					'Kommagetrennt: ID,Name,Level',
				description:
					'Nur diese Spalten in der Ausgabe (leer = alle)',
			},
			{
				displayName:
					'Chunk Size',
				name: 'chunkSize',
				type: 'number',
				typeOptions: {
					minValue: 100,
					maxValue: 50000,
				},
				default: 5000,
				description:
					'Zeilen pro Block (RAM/Performance-Tuning)',
			},
		],
	};

	async execute(
		this: IExecuteFunctions,
	) {
		const items =
			this.getInputData();
		const out: INodeExecutionData[] =
			[];

		for (
			let i = 0;
			i < items.length;
			i++
		) {
			const item = items[i];

			const binaryKey =
				(this.getNodeParameter(
					'binaryProperty',
					i,
					'xlsx',
				) as string) || 'xlsx';

			const sheetParam =
				(this.getNodeParameter(
					'sheet',
					i,
					'',
				) as string) || '';

			// fixedCollection korrekt auslesen:
			// n8n gibt bei multipleValues unter "rules" ein Objekt mit "rule" zurück.
			// "rules.rule" ist das Array der einzelnen Regeln.
			const rulesParam =
				(this.getNodeParameter(
					'rules.rule',
					i,
					[],
				) as FilterRule[]) || [];

			const logic =
				(this.getNodeParameter(
					'logic',
					i,
					'AND',
				) as Logic) || 'AND';

			const columnsStr =
				(this.getNodeParameter(
					'columns',
					i,
					'',
				) as string) || '';

			const chunkSize =
				(this.getNodeParameter(
					'chunkSize',
					i,
					5000,
				) as number) || 5000;

			const rules: FilterRule[] =
				Array.isArray(
					rulesParam,
				)
					? rulesParam.filter(
							(r) =>
								r &&
								r.field,
					  )
					: [];

			const wantedColumns =
				columnsStr
					? columnsStr
							.split(',')
							.map((s) =>
								s.trim(),
							)
							.filter(
								Boolean,
							)
					: undefined;

			const bin =
				item.binary?.[
					binaryKey
				] ||
				item.binary
					?.file ||
				item.binary
					?.data;

			if (!bin) {
				throw new Error(
					`Binary property "${binaryKey}" nicht gefunden (verfügbar: ${
						Object.keys(
							item.binary ||
								{},
						).join(
							', ',
						) || '—'
					})`,
				);
			}

			const buf =
				await this.helpers.getBinaryDataBuffer(
					i,
					binaryKey,
				);

			const sheetNameOrIndex =
				sheetParam === ''
					? undefined
					: /^\d+$/.test(
							sheetParam,
					  )
					? Number(
							sheetParam,
					  )
					: sheetParam;

			const {
				xlsxPath,
				outRows,
				headers,
			} =
				await filterExcelToXlsxStream(
					buf,
					sheetNameOrIndex,
					rules,
					logic,
					wantedColumns,
					chunkSize,
				);

			const xbuf =
				fs.readFileSync(
					xlsxPath,
				);
			const b =
				await this.helpers.prepareBinaryData(
					xbuf,
					'filtered.xlsx',
					'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				);

			const newItem: INodeExecutionData =
				{
					json: {
						matches:
							outRows,
						headers,
					},
					binary: {
						[binaryKey]:
							b,
					},
				};

			out.push(
				newItem,
			);
		}

		return [out];
	}
}
