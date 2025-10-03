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
      const wantTsv = this.getNodeParameter("tsv", i) as boolean;
      const round = this.getNodeParameter("round", i) as number;
      const optRaw = this.getNodeParameter("options", i, {}) as any;

      const extraParameters: string[] = String(optRaw.extraParameters || "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);

      const allParameters = !!optRaw.allParameters;
      const geometryFallback = !!optRaw.geometryFallback;
      const geometryForce = !!optRaw.geometryForce;

      const renameList: { from: string; to: string }[] =
        Array.isArray(optRaw?.rename?.mapping) ? optRaw.rename.mapping : [];

      const bin = items[i].binary?.[binProp];
      if (!bin?.data) {
        throw new NodeOperationError(
          this.getNode(),
          `Binary property "${binProp}" missing`,
          { itemIndex: i }
        );
      }

      const buffer = Buffer.from(bin.data, "base64");

      const rows = await runQtoOnIFC(buffer, {
        extraParameters,
        allParameters,
        geometryFallback,
        geometryForce,
      } as QtoOptions);

      const roundNum = (v: any) => (typeof v === "number" ? Number(v.toFixed(round)) : v);
      const rowsRounded = rows.map((rw) => {
        const copy: any = { ...rw };
        if (copy.Area !== undefined) copy.Area = roundNum(copy.Area);
        if (copy.Volume !== undefined) copy.Volume = roundNum(copy.Volume);
        return copy;
      });

      const rowsRenamed = rowsRounded.map((rw) => {
        const obj: any = { ...rw };
        for (const m of renameList) {
          const from = String(m.from || "").trim();
          const to = String(m.to || "").trim();
          if (!from || !to) continue;
          if (Object.prototype.hasOwnProperty.call(obj, from)) {
            obj[to] = obj[from];
            delete obj[from];
          }
        }
        return obj;
      });

      const newItem: any = { json: { count: rowsRenamed.length }, binary: {} };

      if (wantXlsx) {
        const ws = XLSX.utils.json_to_sheet(rowsRenamed);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "IfcSpaces");
        const xbuf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;

        const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
        xbin.fileName = "spaces_qto.xlsx";
        xbin.mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        newItem.binary["xlsx"] = xbin;
      }

      if (wantTsv) {
        const coreOrder = ["ExpressID", "GlobalId", "Name", "LongName", "Area", "Volume"];
        const allKeys = new Set<string>();
        for (const r of rowsRenamed) Object.keys(r).forEach((k) => allKeys.add(k));
        const extraKeys = [...allKeys].filter((k) => !coreOrder.includes(k)).sort();
        const headers = [...coreOrder.filter((k) => allKeys.has(k)), ...extraKeys];

        const toCell = (v: any) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "number") return String(v).replace(".", ",");
          if (typeof v === "string") return v.replace(/\t/g, " ").replace(/\r?\n/g, " ");
          return String(v);
        };

        const lines: string[] = [];
        lines.push(headers.join("\t"));
        for (const r of rowsRenamed) {
          lines.push(headers.map((h) => toCell((r as any)[h])).join("\t"));
        }

        const tbuf = Buffer.from(lines.join("\n"), "utf8");
        const tbin = await this.helpers.prepareBinaryData(tbuf);
        tbin.fileName = "spaces_qto.tsv";
        tbin.mimeType = "text/tab-separated-values";
        newItem.binary["tsv"] = tbin;
      }

      out.push(newItem);
    }

    return this.prepareOutputData(out);
  }
}
