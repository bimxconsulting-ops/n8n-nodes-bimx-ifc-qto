# n8n-nodes-bimx-ifc-qto

Binary IFC → XLSX/TSV with Area/Volume for IfcSpace, powered by web-ifc (WASM).
Input: Binary property (default data)
Output: xlsx and/or tsv in item.binary, plus json.count.

## ✨ What this Node does

Reads an IFC file from an n8n item’s binary property.

Extracts IfcSpace rows and outputs a table (XLSX/TSV).

Returns Area and Volume either from IFC Quantities or by computing them from geometry meshes (fallback or forced).

Can include any IFC property you need (all or selected).

Can rename attributes on the fly (e.g., map a misplaced room number from Name → RoomNumber).

Rounds numeric fields to a chosen number of decimals.

Works locally and on self-hosted n8n.

## 🧩 Install

In n8n: Settings → Community Nodes → Install → search for
n8n-nodes-bimx-ifc-qto

## ▶️ Usage (minimal)

Read Binary File (your IFC) → property data

BIM X – IFC Space QTO (binaryProperty = data)

Write Binary File (XLSX/TSV) or send via SharePoint/Email

## ⚙️ Parameters (as in the node UI)
Required / basics

Binary Property (string) – name of the binary field that holds the IFC (default data).

Generate XLSX (boolean) – add a xlsx binary file named spaces_qto.xlsx.

Generate TSV (comma decimal) (boolean) – add a tsv binary file named spaces_qto.tsv (tab-separated; decimal comma style).

Round Decimals (number) – rounding applied to numeric output values (default in code path when provided).

Options (collection)

All Parameters (boolean)
If true, include all IfcSpace properties collected from Psets (IFCPROPERTYSET / IFCPROPERTYSINGLEVALUE) in the output row.

Use Geometry Fallback (boolean)
If true, and Area/Volume are missing from IFC quantities, the node will compute them from the meshes.

Force Geometry (boolean)
If true, always compute Area/Volume from geometry and override quantity values found in the IFC.

Extra Parameters (multi)
List of property names to additionally include (if you don’t want all). Example: LongName, OccupancyType, RoomNumber, …

Rename (multi)
Pairs of { parameterName, newName }. If the key exists in the output row, it will be copied to newName (and the old key removed when names differ).
Example: Name → RoomNumber.

## 📤 Output

Each processed item yields:

json.count – number of IfcSpace rows produced.

binary:

xlsx (optional) – Excel workbook, sheet Spaces.

tsv (optional) – Tab-separated text with headers; decimal-comma style.

## 🧠 How Area & Volume are computed

The node uses web-ifc (IfcAPI) to either:

Read IFC quantities

Traverses IfcRelDefinesByProperties to find:

IFCELEMENTQUANTITY → IFCQUANTITYAREA and IFCQUANTITYVOLUME

IFCPROPERTYSET → IFCPROPERTYSINGLEVALUE (for general props)

If found (and Force Geometry is off), Area/Volume come directly from these quantities.

Compute from geometry (when Use Geometry Fallback or Force Geometry is set)

Loads geometry for each IfcSpace (two robust paths are implemented):

Low-level: GetGeometry → GetIndexArray / GetVertexArray

Flat mesh traversal: LoadAllGeometry and per-fragment GetGeometry

Applies an optional 4×4 transform matrix if present (handles common property names like matrix, transformMatrix, coordinationMatrix).

Area (XY footprint): sums projected triangle areas (triangleArea2D) on the XY plane via footprintAreaXY.

Volume: computes a signed-tetrahedron volume over all indexed triangles via meshVolume (absolute value / 6).

Returns { area, volume } only when positive (>0).

Rounding is done only on output (internal calculations remain high precision).

## 🔍 Property collection details

For every IfcSpace, the node adds:

GlobalId, Name, LongName

IFC Psets values (either all, or only those listed under Extra Parameters)

Area, Volume from quantities or geometry (per the options)

Renamed keys applied at the end

Defensive parsing: gracefully handles missing props/quantities/geometry fragments and continues.

## ✅ Example recipes

Fix “room number in Name”: add Rename → Name → RoomNumber.

Always trust geometry over potentially stale quantities: Force Geometry = ON.

Prefer quantities, but fill gaps: Use Geometry Fallback = ON, Force Geometry = OFF.

Include only specific fields: All Parameters = OFF, list desired keys in Extra Parameters.

Full dump for AI: All Parameters = ON (+ XLSX).

## 🧯 Errors & edge cases

If the binary property is missing or empty, the node throws a NodeOperationError.

When there are no IfcSpace instances, outputs json.count = 0 and empty files where applicable.

Geometry APIs differ slightly by web-ifc version; the implementation tries both low-level and flat-mesh paths and releases geometry if supported.
 
## 📦 Build & runtime notes

Uses web-ifc WASM. In Node, we do not set a custom WASM path; IfcAPI.Init() is called before opening the model.

XLSX creation via xlsx library (XLSX.utils.json_to_sheet, XLSX.write).

TSV writer builds headers from the first row and writes tab-separated lines (UTF-8).

## 🗺️ Field reference (common)

Typical columns you’ll see:

GlobalId, Name, LongName

Area, Volume

Any properties from IFC Psets you requested (via All Parameters or Extra Parameters)

Any renamed keys you configured

## 🧪 Quick test workflow

Read Binary File → data

BIM X – IFC Space QTO

binaryProperty = data

Generate XLSX = true

Round Decimals = 2

Options → Use Geometry Fallback = true

Write Binary File → spaces_qto.xlsx

License & Support

Created by BIM X Consulting.

For support, workshops, or enterprise requests (automation, AI, BIM data): bim-x-consulting.de

# n8n-nodes-bimx-ifc-qto (DE)

Binary IFC → XLSX/TSV mit Fläche/Volumen für IfcSpace, auf Basis von web-ifc (WASM).
Input: Binary-Property (Standard data)
Output: xlsx und/oder tsv in item.binary + json.count.

## ✨ Was der Node macht

Liest eine IFC-Datei aus einem binary-Feld des Items.

Extrahiert IfcSpace-Zeilen und erzeugt eine Tabelle (XLSX/TSV).

Liefert Fläche und Volumen entweder aus den IFC-Quantities oder – als Fallback/Forced – über eine Geometrieberechnung aus den Meshes.

Kann beliebige IFC-Eigenschaften ausgeben (alle oder gezielt).

Benennt Attribute um (z. B. Name → RoomNumber).

Rundet Zahlenwerte auf die gewünschte Nachkommastelle.

Läuft lokal und in self-hosted n8n.

## 🧩 Installation

In n8n: Settings → Community Nodes → Install → Suche
n8n-nodes-bimx-ifc-qto

## ▶️ Verwendung (Minimalbeispiel)

Read Binary File (IFC) → Property data

BIM X – IFC Space QTO (binaryProperty = data)

Write Binary File (XLSX/TSV) oder weiterleiten (SharePoint/E-Mail)

## ⚙️ Parameter (wie im UI)
Basis

Binary Property (string) – Name des Binary-Felds mit der IFC (Standard data).

Generate XLSX (boolean) – erzeugt spaces_qto.xlsx im Binary.

Generate TSV (comma decimal) (boolean) – erzeugt spaces_qto.tsv (Tab-getrennt; Dezimal-Komma).

Round Decimals (number) – Rundung für numerische Ausgabewerte.

Options (Sammlung)

All Parameters (boolean)
Wenn an, werden alle Eigenschaften des IfcSpace aus Psets (IFCPROPERTYSET / IFCPROPERTYSINGLEVALUE) in die Zeile aufgenommen.

Use Geometry Fallback (boolean)
Wenn an und Fläche/Volumen fehlen in den Quantities, werden sie aus der Geometrie berechnet.

Force Geometry (boolean)
Wenn an, werden Fläche/Volumen immer aus der Geometrie berechnet und etwaige Quantity-Werte überschrieben.

Extra Parameters (mehrfach)
Liste von Eigenschaftsnamen, die zusätzlich aufgenommen werden sollen (wenn man nicht alle möchte).

Rename (mehrfach)
Paare { parameterName, newName }. Existiert der Schlüssel in der Zeile, wird er nach newName kopiert (alter Schlüssel wird entfernt, wenn Namen unterschiedlich sind).
Beispiel: Name → RoomNumber.

## 📤 Ausgabe

Pro verarbeitetem Item:

json.count – Anzahl der erzeugten IfcSpace-Zeilen.

binary:

xlsx (optional) – Excel mit Sheet Spaces.

tsv (optional) – Tab-getrennte Datei mit Kopfzeile (Dezimal-Komma Stil).

## 🧠 Wie Fläche & Volumen berechnet werden

IFC-Quantities lesen

Traversiert IfcRelDefinesByProperties und findet:

IFCELEMENTQUANTITY → IFCQUANTITYAREA, IFCQUANTITYVOLUME

IFCPROPERTYSET → IFCPROPERTYSINGLEVALUE (allgemeine Eigenschaften)

Wenn Werte vorhanden sind (und Force Geometry aus), werden sie direkt verwendet.

Berechnung aus Geometrie (bei Use Geometry Fallback oder Force Geometry)

Lädt die Geometrie des jeweiligen IfcSpace über zwei robuste Pfade:

Low-level GetGeometry → GetIndexArray / GetVertexArray

Flat-Mesh via LoadAllGeometry und pro Fragment GetGeometry

Berücksichtigt ggf. eine 4×4 Transformationsmatrix (unter bekannten Schlüsseln wie matrix, transformMatrix, coordinationMatrix).

Fläche (XY-Fußabdruck): Summe der projizierten Dreiecksflächen (triangleArea2D) über footprintAreaXY.

Volumen: Signed-Tetrahedron-Verfahren über alle Dreiecke mittels meshVolume (Betrag / 6).

Gibt { area, volume } nur zurück, wenn Werte > 0 sind.

Die Rundung erfolgt nur auf der Ausgabe.

## 🔍 Details zur Eigenschaftserfassung

Pro IfcSpace:

GlobalId, Name, LongName

Pset-Werte (alle oder gezielt über Extra Parameters)

Area, Volume aus Quantities oder Geometrie (gemäß Optionen)

Rename wird am Ende angewendet

Robuste, defensive Verarbeitung – fehlende Eigenschaften/Geometrie führen nicht zum Abbruch.

## ✅ Anwendungs-Rezepte

„Raumnummer steht in Name“: Rename → Name → RoomNumber.

Geometrie ist maßgeblich: Force Geometry = AN.

Quantities bevorzugen, Lücken füllen: Use Geometry Fallback = AN, Force Geometry = AUS.

Nur bestimmte Felder: All Parameters = AUS, gewünschte Keys in Extra Parameters.

Voller Dump für KI/Dashboards: All Parameters = AN (+ XLSX).

## 🧯 Fehler & Spezialfälle

Fehlendes Binary (IFC) → NodeOperationError.

Keine IfcSpace gefunden → json.count = 0, leere Datei(en) sofern generiert.

Unterschiede zwischen web-ifc-Versionen werden abgefangen (zwei Geometriepfade, optionales ReleaseGeometry).

## 📦 Build & Laufzeit

web-ifc (WASM) – IfcAPI.Init() wird in Node aufgerufen; kein manuelles SetWasmPath.

XLSX über xlsx-Lib (json_to_sheet, write).

TSV wird manuell erzeugt (Tab-getrennt, UTF-8).

## 🗺️ Häufige Spalten

GlobalId, Name, LongName, Area, Volume, gewünschte Pset-Eigenschaften, umbenannte Keys.

## 🧪 Schnelltest

Read Binary File → data

BIM X – IFC Space QTO

binaryProperty = data

Generate XLSX = true

Round Decimals = 2

Options → Use Geometry Fallback = true

Write Binary File → spaces_qto.xlsx
