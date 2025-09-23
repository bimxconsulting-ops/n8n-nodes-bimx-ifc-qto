# n8n-nodes-bimx-ifc-qto

Binary IFC → XLSX/TSV with Area/Volume of `IfcSpace` using web-ifc (WASM).  
**Input:** Binary property (default `data`)  
**Output:** `xlsx` and/or `tsv` in item.binary + `json.count`.

## Install
n8n → Settings → Community Nodes → Install → search `n8n-nodes-bimx-ifc-qto`.

## Usage
1. Read Binary File (IFC) → property `data`
2. BIM X – IFC Space QTO (binaryProperty=`data`)
3. Write Binary File (xlsx/tsv) or send to SharePoint/Email
