// src/index.ts
import type { INodeType } from 'n8n-workflow';

import { BimxIfcSpaceQto } from './nodes/BimxIfcSpaceQto.node';
import { IfcParameterExplorer } from './nodes/IfcParameterExplorer.node';

/**
 * n8n lädt Community-Packages entweder über diese Exporte
 * ODER über das "n8n"-Manifest in der package.json (siehe unten).
 * Beides zu haben ist ok.
 */
export const nodes: INodeType[] = [
	BimxIfcSpaceQto,
	IfcParameterExplorer,
];

export const credentials = [];
