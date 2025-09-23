const fs = require("fs");
const path = require("path");

// 1) Den von Node aufgelösten Haupteinstieg von web-ifc finden
const entry = require.resolve("web-ifc"); // z. B. .../node_modules/web-ifc/web-ifc-api.js
const base = path.dirname(entry);

// 2) Mögliche Orte der WASM-Datei (je nach web-ifc-Version / Build)
const candidates = [
  path.join(base, "web-ifc.wasm"),
  path.join(base, "dist", "web-ifc.wasm"),
  path.join(base, "..", "web-ifc.wasm"),
  path.join(base, "..", "dist", "web-ifc.wasm"),
  path.join(base, "..", "lib", "web-ifc.wasm"),
];

const src = candidates.find(p => fs.existsSync(p));
if (!src) {
  throw new Error(
    `web-ifc.wasm not found. Tried:\n - ${candidates.join("\n - ")}\nResolved entry: ${entry}`
  );
}

const destDir = path.join(__dirname, "..", "dist", "wasm");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, "web-ifc.wasm"));

console.log("✔ copied", src, "→", path.join(destDir, "web-ifc.wasm"));
