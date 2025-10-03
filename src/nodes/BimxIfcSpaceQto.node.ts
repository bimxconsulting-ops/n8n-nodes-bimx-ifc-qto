// src/nodes/BimxIfcSpaceQto.node.ts
import type { IExecuteFunctions } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import type { INodeType, INodeTypeDescription } from "n8n-workflow";
import * as XLSX from "xlsx";
import { runQtoOnIFC, type QtoOptions } from "../lib/compute";

export class BimxIfcSpaceQto implements INodeType {
  description: INodeTypeDescription = {
    displayName: "BIM X – IFC Space QTO",
    name: "bimxIfcSpaceQto",
    icon: "file:BIMX.svg",
    group: ["transform"],
    version: 1,
    description: "Binary IFC in → XLSX/TSV out (Area/Volume of IfcSpaces via web-ifc)",
    defaults: { name: "BIM X – IFC Space QTO" },
    inputs: ["main"],
    outputs: ["main"],
    properties: [
      {
        displayName: "Binary Property",
        name: "binaryProperty",
        type: "string",
        default: "data",
        description: "Name of the binary property that contains the IFC file",
      },
      {
        displayName: "Generate XLSX",
        name: "xlsx",
        type: "boolean",
        default: true,
      },
      {
        displayName: "Generate TSV (comma decimal)",
        name: "tsv",
        type: "boolean",
        default: true,
      },
      {
        displayName: "Round Decimals",
        name: "round",
        type: "number",
        typeOptions: { minValue: 0, maxValue: 10 },
        default: 8,
      },

      // ===== Options (Add options) =====
      {
        displayName: "Options",
        name: "options",
        type: "collection",
        default: {},
        placeholder: "Add options",
        options: [
          {
            displayName: "Extra Parameters (comma-separated)",
            name: "extraParameters",
            type: "string",
            default: "",
            description:
              "Weitere Attributnamen, die (falls vorhanden) zusätzlich aus Spaces gelesen werden sollen. Beispiel: Department,Number,Zone",
          },
          {
            displayName: "All Parameters",
            name: "allParameters",
            type: "boolean",
            default: false,
            description:
              "Wenn aktiviert, werden alle Parameter/Quantities/Psets der IfcSpaces flach ausgegeben (z.B. PsetName.Property, QtoName.Quantity).",
          },
          {
            displayName: "Use Geometry Fallback",
            name: "geometryFallback",
            type: "boolean",
            default: true,
            description:
              "Falls Area/Volume in den Quantities fehlen, werden sie aus der IfcSpace-Mesh-Geometrie trianguliert berechnet.",
          },
          {
            displayName: "Force Geometry",
            name: "geometryForce",
            type: "boolean",
            default: false,
            description:
              "Area/Volume immer aus der Geometrie berechnen (überschreibt vorhandene Quantities).",
          },
          {
            displayName: "Rename",
            name: "rename",
            type: "fixedCollection",
            typeOptions: { multipleValues: true },
            default: {},
            options: [
              {
                name: "mapping",
                displayName: "Mapping",
                values: [
                  {
                    displayName: "Parameter Name",
                    name: "from",
                    type: "string",
                    default: "",
                  },
                  {
                    displayName: "New Name",
                    name: "to",
                    type: "string",
                    default: "",
                  },
                ],
              },
            ],
            description:
              "Felder im Output umbenennen. Beispiel: Parameter Name=LongName → New Name=SpaceLongName",
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const out: any[] = [];

    for (let i = 0; i < items.length; i++) {
      const binProp = this.getNodeParameter("binaryProperty", i) as string;
      const wantXlsx = this.getNodeParameter("xlsx", i) as boolean;
      const wantTsv = this.getNodePar
