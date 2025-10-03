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
        description: "Name of the binary property that contains the IFC file"
      },
      {
        displayName: "Generate XLSX",
        name: "xlsx",
        type: "boolean",
        default: true
      },
      {
        displayName: "Generate TSV (comma decimal)",
        name: "tsv",
        type: "boolean",
        default: true
      },
      {
        displayName: "Round Decimals",
        name: "round",
        type: "number",
        typeOptions: { minValue: 0, maxValue: 10 },
        default: 8
      }
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

      const bin = items[i].binary?.[binProp];
      if (!bin?.data) {
        throw new NodeOperationError(this.getNode(), `Binary property "${binProp}" missing`, { itemIndex: i });
      }

      const buffer = Buffer.from(bin.data, "base64");
      const rows = await runQtoOnIFC(buffer);

      const r = (v: any) => typeof v === "number" ? Number(v.toFixed(round)) : v;
      const rowsRounded = rows.map(rw => ({ ...rw, Area: r(rw.Area), Volume: r(rw.Volume) }));

      const newItem: any = { json: { count: rows.length }, binary: {} };

      if (wantXlsx) {
        // Build XLSX in-memory
        const ws = XLSX.utils.json_to_sheet(rowsRounded);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Spaces_PSet");
        const xbuf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;

        // prepareBinaryData: nur 1 Argument in deiner n8n-Version
        const xbin = await this.helpers.prepareBinaryData(Buffer.from(xbuf));
        xbin.fileName = "spaces_qto.xlsx";
        xbin.mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        newItem.binary["xlsx"] = xbin;
      }

      if (wantTsv) {
        // TSV mit Komma-Dezimal
        const lines = [
          "Area\tVolume",
          ...rowsRounded.map(rw =>
            `${String(rw.Area ?? "").replace(".", ",")}\t${String(rw.Volume ?? "").replace(".", ",")}`
          ),
        ];
        const tbuf = Buffer.from(lines.join("\n"), "utf8");

        const tbin = await this.helpers.prepareBinaryData(tbuf);
        tbin.fileName = "pset_revit_dimensions.tsv";
        tbin.mimeType = "text/tab-separated-values";
        newItem.binary["tsv"] = tbin;
      }

      out.push(newItem);
    }

    return this.prepareOutputData(out);
  }
}
