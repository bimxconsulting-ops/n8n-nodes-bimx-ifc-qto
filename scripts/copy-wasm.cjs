const fs = require("fs");
const path = require("path");

// Basis: Installationsordner vom Paket
const pkgDir = path.dirname(require.resolve("web-ifc/package.json"));

// Mögliche Orte der WASM-Datei (je nach Version von web-ifc)
const candidates = [
  path.join(pkgDir, "web-ifc.wasm"),
  path.join(pkgDir, "dist", "web-ifc.wasm"),
  path.join(pkgDir, "lib", "web-ifc.wasm"),
];

const src = candidates.find(p => fs.existsSync(p));
if (!src) {
  throw new Error(
    `web-ifc.wasm not found. Tried:\n - ${candidates.join("\n - ")}`
  );
}

const destDir = path.join(__dirname, "..", "dist", "wasm");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, "web-ifc.wasm"));

console.log("✔ copied", src, "→", path.join(destDir, "web-ifc.wasm"));
