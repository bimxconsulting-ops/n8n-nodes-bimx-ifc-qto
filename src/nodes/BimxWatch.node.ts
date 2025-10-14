// src/nodes/BimxWatch.node.ts
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';

function inferType(v: any): string {
	if (v === null || v === undefined) return 'null';
	if (Array.isArray(v)) return 'array';
	const t = typeof v;
	if (t === 'string') {
		// naive heuristics
		if (v.trim() !== '' && !isNaN(Number(v))) return 'number|string';
		if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'date|string';
		return 'string';
	}
	if (t === 'number') return Number.isInteger(v) ? 'integer' : 'number';
	if (t === 'boolean') return 'boolean';
	if (t === 'object') return 'object';
	return t;
}

function takeSampleIndices(total: number, mode: 'firstN'|'lastN'|'randomN', n: number): number[] {
	if (total <= 0 || n <= 0) return [];
	if (mode === 'firstN') return Array.from({ length: Math.min(n, total) }, (_, i) => i);
	if (mode === 'lastN') {
		const k = Math.min(n, total);
		return Array.from({ length: k }, (_, i) => total - k + i);
	}
	// randomN (unique)
	const k = Math.min(n, total);
	const set = new Set<number>();
	while (set.size < k) set.add(Math.floor(Math.random() * total));
	return Array.from(set.values()).sort((a, b) => a - b);
}

export class BimxWatch implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BIM X - Watch',
		name: 'bimxWatch',
		icon: 'file:BIMX.svg',
		group: ['transform'],
		version: 1,
		description: 'Tap between nodes to preview items, schema, booleans, and stats',
		defaults: { name: 'BIM X - Watch' },
		inputs: ['main'],
		outputs: ['main', 'main'], // [pass-through, meta]
		properties: [
			{
				displayName: 'Sample Mode',
				name: 'sampleMode',
				type: 'options',
				default: 'firstN',
				options: [
					{ name: 'First N', value: 'firstN' },
					{ name: 'Last N', value: 'lastN' },
					{ name: 'Random N', value: 'randomN' },
				],
			},
			{
				displayName: 'Sample Size',
				name: 'sampleSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5000 },
				default: 20,
			},
			{
				displayName: 'Max String Length',
				name: 'maxStringLen',
				type: 'number',
				typeOptions: { minValue: 10, maxValue: 100000 },
				default: 200,
			},
			{
				displayName: 'Show Boolean Stats',
				name: 'showBooleans',
				type: 'boolean',
				default: true,
			},
			{
				displayName: 'Infer Types',
				name: 'inferTypes',
				type: 'boolean',
				default: true,
			},
			{
				displayName: 'Include Schema',
				name: 'includeSchema',
				type: 'boolean',
				default: true,
			},
			{
				displayName: 'Output Meta Only (no pass-through)',
				name: 'outputMetaOnly',
				type: 'boolean',
				default: false,
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();

		const sampleMode = this.getNodeParameter('sampleMode', 0) as 'firstN'|'lastN'|'randomN';
		const sampleSize = this.getNodeParameter('sampleSize', 0) as number;
		const maxStringLen = this.getNodeParameter('maxStringLen', 0) as number;
		const showBooleans = this.getNodeParameter('showBooleans', 0) as boolean;
		const inferTypesFlag = this.getNodeParameter('inferTypes', 0) as boolean;
		const includeSchema = this.getNodeParameter('includeSchema', 0) as boolean;
		const outputMetaOnly = this.getNodeParameter('outputMetaOnly', 0) as boolean;

		const total = items.length;
		const indices = takeSampleIndices(total, sampleMode, sampleSize);

		// Build preview (truncate long strings)
		const preview = indices.map((i) => {
			const src = (items[i]?.json ?? {}) as Record<string, any>;
			const row: Record<string, any> = {};
			for (const [k, v] of Object.entries(src)) {
				if (typeof v === 'string' && v.length > maxStringLen) {
					row[k] = v.slice(0, maxStringLen) + '…';
				} else {
					row[k] = v;
				}
			}
			return row;
		});

		// Boolean stats
		let booleanStats: Record<string, { true: number; false: number; nullish: number }> | undefined;
		if (showBooleans && total > 0) {
			const allKeys = new Set<string>();
			for (const it of items) Object.keys((it.json ?? {}) as Record<string, any>).forEach((k) => allKeys.add(k));
			const stats: Record<string, { true: number; false: number; nullish: number }> = {};
			for (const key of allKeys) {
				let t = 0, f = 0, nl = 0;
				for (const it of items) {
					const v = (it.json as any)?.[key];
					if (v === true) t++;
					else if (v === false) f++;
					else nl++;
				}
				stats[key] = { true: t, false: f, nullish: nl };
			}
			booleanStats = stats;
		}

		// Schema inference
		let schema: Record<string, { types: Record<string, number>; nulls: number; uniques: number }> | undefined;
		if (includeSchema && total > 0) {
			const allKeys = new Set<string>();
			for (const it of items) Object.keys((it.json ?? {}) as Record<string, any>).forEach((k) => allKeys.add(k));

			const sc: Record<string, { types: Record<string, number>; nulls: number; uniques: number }> = {};
			for (const key of allKeys) {
				const typesCount: Record<string, number> = {};
				let nulls = 0;
				const seen = new Set<string>();
				for (const it of items) {
					const v = (it.json as any)?.[key];
					if (v === null || v === undefined) { nulls++; continue; }
					const t = inferTypesFlag ? inferType(v) : typeof v;
					typesCount[t] = (typesCount[t] || 0) + 1;
					if (['string', 'number', 'boolean'].includes(typeof v)) {
						seen.add(String(v));
					}
				}
				sc[key] = { types: typesCount, nulls, uniques: seen.size };
			}
			schema = sc;
		}

		const metaItem: INodeExecutionData = {
			json: {
				watch: {
					totalItems: total,
					sampleMode,
					sampleSize: indices.length,
					sampleIndices: indices,
					preview,
					stats: {
						booleans: booleanStats,
						columns: schema ? Object.keys(schema) : [],
					},
					schema,
				},
			},
		};

		const passThrough = outputMetaOnly ? [] : items;
		return [passThrough, [metaItem]];
	}
}
