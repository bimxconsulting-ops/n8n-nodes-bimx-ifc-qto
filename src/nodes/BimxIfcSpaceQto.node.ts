import type { IExecuteFunctions } from "n8n-workflow";
import { NodeOperationError } from "n8n-workflow";
import type { INodeType, INodeTypeDescription } from "n8n-workflow";
import * as XLSX from "xlsx";
import { runQtoOnIFC } from "../lib/compute";

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
      {
        displayName: "Default Height (m)",
        name: "defaultHeight",
        type: "number",
        typeOptions: { minValue: 0 },
        default: 2.8,
        description:
          "Used if no reliable storey height can be derived. Multiplied with 2D area to estimate volume.",
      },
      {
        displayName: "XY Scale",
        name: "scaleXY",
        type: "number",
        typeOptions: { minValue: 0 },
        default: 1,
        description:
          "Apply a scale factor to 2D footprints if the model units require it (rare).",
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
      const defaultHeight = this.getNodeParameter("defaultHeight", i) as number;
      const scaleXY = this.getNodeParameter("scaleXY", i) as number;

      const bin = items[i].binary?.[binProp];
      if (!bin?.data) {
        throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" missing`, {
          itemIndex: i,
        });
      }

      const buffer = Buffer.from(bin.data, "base64");

      // runQtoOnIFC muss die Optionen (defaultHeight, scaleXY) akzeptieren
      const rows = await runQtoOnIFC(buffer, { defaultHeight, scaleXY });

      // nur Area/Volume runden – alle anderen Felder unverändert lassen
      const r = (v: any) => (typeof v === "number" ? Number(v.toFixed(round)) : v);
      const rowsRounded = rows.map((rw: any) => ({
        ...rw,
        Area: r(rw.Area),
        Volume: r(rw.Volume),
      }));

      const newItem: any = { json: { count: rows.length }, binary: {} };

      if (wantXlsx) {
        const ws = XLSX.utils.json_to_sheet(rowsRounded);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Spaces_QTO");
        const xbuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        newItem.binary["xlsx"] = await this.helpers.prepareBinaryData(
          Buffer.from(xbuf),
          "spaces_qto.xlsx",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
      }

      if (wantTsv) {
        // TSV mit Komma-Dezimaltrenner. Alle Spalten, nicht nur Area/Volume.
        const headers =
          rowsRounded.length > 0 ? Object.keys(rowsRounded[0]) : ["Area", "Volume"];
        const toCsv = (v: any) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "number") return String(v).replace(".", ",");
          // Strings: Tabs und Zeilenumbrüche escapen
          const s = String(v).replace(/\t/g, " ").replace(/\r?\n/g, " ");
          return s;
        };

        const lines = [
          headers.join("\t"),
          ...rowsRounded.map((rw: any) => headers.map((h) => toCsv(rw[h])).join("\t")),
        ];

        const tbuf = Buffer.from(lines.join("\n"), "utf8");
        newItem.binary["tsv"] = await this.helpers.prepareBinaryData(
          tbuf,
          "spaces_qto.tsv",
          "text/tab-separated-values",
        );
      }

      out.push(newItem);
    }

    return this.prepareOutputData(out);
  }
}
