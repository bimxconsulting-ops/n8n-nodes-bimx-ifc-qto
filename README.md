# 🧱 BIM X – IFC QTO (n8n Community Node)

A collection of n8n Community Nodes for IFC extraction, reporting, and validation:  
Space QTO, Attribute Export, Table Filter, Rule Validator, SmartViews/BCSV Builder, and Watch/Preview Node.

---

## 🧩 Key Nodes & Workflow

### 🧱 BIM X – IFC Space QTO
Reads binary IFC files (`binary` property, e.g., from Read Binary File node) and exports `IfcSpace` records as XLSX/TSV + JSON.  
Calculates Area and Volume from IFC quantities or via geometry fallback.  
Rename fields, add extra properties, and round decimals.

➡️ Ideal for generating room schedules for thermal calculations, dashboards, or AI pipelines.

---

### 🧾 BIM X – IFC Attribute Export
Exports IFC model properties to XLSX or JSON.  
Modes:

- **Wide:** One row per element with all properties  
- **Narrow:** Key/Value format for easier merging or rule checks  

Supports filtering by entity types and excluding meta classes (e.g. `IfcProject`, `IfcSite`).

---

### 🔍 BIM X – Table Filter
Filters any tabular dataset by:

- Column  
- Operator (=, ≠, >, <, regex, etc.)  
- Value  

Works like a lightweight query engine inside n8n — no code required.

---

### ✅ BIM X – Rule Validator
Executes validation rules on exported tables.  
Each rule: Field, Operator, Value or Regex.  
Output options:

- XLSX report (optional highlighting)  
- JSON metadata (GUID lists per rule)  
- CSV lists per rule  

Rules can be imported via JSON or YAML.  
Perfect for QA/QC checks in BIM processes.

---

### 🎨 BIM X – SmartViews / BCSV Builder
Processes Rule Validator output (GUID lists) and generates a BIMcollab SmartViews (`.bcsv`) file.  
Import in BIMcollab → automatically isolate and color invalid objects.  
Customizable colors and isolate flags.

👉 Recommended chain: Rule Validator → BCSV Builder → BIMcollab.

---

### 👀 BIM X – Watch
Displays data in a compact HTML report (table + charts).  
Great for quick visual checks in n8n without manual export.

---

## 💡 Why TSV (Tab-separated) instead of CSV?
IFC data often includes commas — either as decimal separators (in German localization) or within text fields (`"Room 1, Ground Floor"`).  
TSV avoids delimiter conflicts and import issues.

TSV files can be opened directly in Excel:  
**Data → From Text/CSV → Delimiter: Tab**

---

## ⚙️ Example Workflow

| Step | Node | Setting |
|------|------|----------|
| 1 | Read Binary File | → data |
| 2 | BIM X – IFC Space QTO | `binaryProperty = data`<br>Generate XLSX = true<br>Round Decimals = 2<br>Use Geometry Fallback = true |
| 3 | Write Binary File | → `spaces_qto.xlsx` |

(Optional) Send via SharePoint / Email.

---

## 🧩 Install
In n8n: Settings → Community Nodes → Install → search for n8n-nodes-bimx-ifc-qto

---

## 🧠 Technical Notes

- web-ifc (WASM) backend — `IfcAPI.Init()` auto-loaded, no manual WASM path needed
- Excel export via `xlsx` / `exceljs`
- TSV writer built manually (UTF-8, tab-separated, decimal comma option)
- Compatible with self-hosted n8n
- Productively tested by BIM X Consulting

---

## ☕ Support this project

If these tools help you, consider buying me a coffee ☕
👉 PayPal – Daniel Glober / BIM X Consulting

<p align="center"> <a href="https://www.paypal.me/danielglober"> <img src="https://www.paypalobjects.com/webstatic/icon/pp258.png" width="80" alt="PayPal" /> </a> <br/> <img src="https://raw.githubusercontent.com/bimxconsulting-ops/n8n-nodes-bimx-ifc-qto/main/docs/paypal_qr.png" width="180" alt="PayPal QR Code" /> </p>

💬 Every cup of coffee helps develop more automation tools for the BIM community!

---

## 🧾 License

MIT License
© BIM X Consulting – Daniel Glober
🌐 www.bim-x-consulting.de

---


🇩🇪 Deutsche Übersetzung

Binäre IFC → XLSX/TSV (Fläche/Volumen für IfcSpace) — basiert auf web-ifc (WASM).
Eine Sammlung von n8n Community Nodes für IFC-Extraktion, Reporting und Validierung:
Space QTO, Attributexport, Tabellenfilter, Regelvalidierung, SmartViews/BCSV Builder und Watch/Preview Node.

---

## 🧩 Wichtige Nodes & Workflow
### 🧱 BIM X – IFC Space QTO

Liest binäre IFC-Dateien (binary-Property, z. B. aus Read Binary File Node) und exportiert IfcSpace-Datensätze als XLSX/TSV + JSON.
Berechnet Fläche und Volumen aus IFC-Quantitäten oder über Geometrie-Fallback.
Du kannst Attribute umbenennen, zusätzliche Eigenschaften hinzufügen und Zahlen runden.

➡️ Ideal zur Erstellung von Raumtabellen für thermische Berechnungen, Dashboards oder KI-Pipelines.

---

## 🧾 BIM X – IFC Attribute Export

Exportiert Eigenschaften aus dem IFC-Modell nach XLSX oder JSON.
Modi:

- Wide: Eine Zeile pro Element mit allen Eigenschaften
- Narrow: Key/Value-Format für einfacheres Zusammenführen oder Prüfen

Filter nach Entitätstypen oder Ausschluss von Metaklassen (z. B. IfcProject, IfcSite).

---

## 🔍 BIM X – Table Filter

Filtert beliebige tabellarische Datensätze nach:

- Spalte
- Operator (=, ≠, >, <, regex, etc.)
- Wert

Funktioniert wie eine einfache Abfrage-Engine innerhalb von n8n – ganz ohne Code.

---

## ✅ BIM X – Rule Validator

Führt Validierungsregeln auf exportierten Tabellen aus.
Jede Regel: Feld, Operator, Wert oder Regex.
Ausgabe:

- XLSX-Report (optional mit Hervorhebung)
- JSON-Metadaten (GUID-Listen je Regel)
- CSV-Listen je Regel

Regeln können als JSON oder YAML importiert werden.
Ideal für QA/QC-Prüfungen in BIM-Prozessen.

---

## 🎨 BIM X – SmartViews / BCSV Builder

Verarbeitet die Ausgabe des Rule Validators (GUID-Listen) und erstellt eine BIMcollab SmartViews (.bcsv)-Datei.
In BIMcollab importieren → fehlerhafte Objekte automatisch isolieren und einfärben.
Farben und Isolate-Flags frei definierbar.

👉 Empfohlene Kette: Rule Validator → BCSV Builder → BIMcollab.

---

## 👀 BIM X – Watch

Zeigt Daten in einem kompakten HTML-Report (Tabelle + Diagramme) an.
Ideal für schnelle visuelle Prüfungen in n8n ohne manuellen Export.

---

## 💡 Warum TSV (Tab-getrennt) statt CSV?

IFC-Daten enthalten oft Kommas – entweder als Dezimaltrennzeichen (deutsche Lokalisierung) oder in Textfeldern ("Raum 1, EG").
TSV vermeidet Trennzeichen-Konflikte und Importprobleme.

TSV-Dateien können direkt in Excel geöffnet werden:
Daten → Text/CSV importieren → Trennzeichen: Tab

---

## ⚙️ Beispiel-Workflow

| Schritt | Node | Einstellung |
|------|------|----------|
| 1 | Read Binary File | → data |
| 2 | BIM X – IFC Space QTO | `binaryProperty = data`<br>Generate XLSX = true<br>Dezimalstellen = 2<br>Geometrie-Fallback = true |
| 3 | Write Binary File | → `spaces_qto.xlsx` |

(Optional) Versand über SharePoint / E-Mail.

---

## 🧩 Installation

In n8n:
Settings → Community Nodes → Install → suche nach n8n-nodes-bimx-ifc-qto


---

## 🧠 Technische Hinweise

web-ifc (WASM) Backend – IfcAPI.Init() automatisch geladen, kein manueller Pfad nötig
Excel-Export via xlsx / exceljs
TSV-Writer manuell implementiert (UTF-8, Tab-getrennt, Dezimalkomma-Option)
Kompatibel mit self-hosted n8n
Produktiv getestet von BIM X Consulting


---

## ☕ Unterstütze das Projekt

Wenn dir diese Tools helfen, freue ich mich über eine kleine Spende ☕
👉 PayPal – Daniel Glober / BIM X Consulting

<p align="center"> <a href="https://www.paypal.me/danielglober"> <img src="https://www.paypalobjects.com/webstatic/icon/pp258.png" width="80" alt="PayPal" /> </a> <br/> <img src="https://raw.githubusercontent.com/bimxconsulting-ops/n8n-nodes-bimx-ifc-qto/main/docs/paypal_qr.png" width="180" alt="PayPal QR Code" /> </p>

💬 Jede Tasse Kaffee hilft, weitere Automatisierungstools für die BIM-Community zu entwickeln!

---

## 🧾 Lizenz

MIT License
© BIM X Consulting – Daniel Glober
🌐 www.bim-x-consulting.de
