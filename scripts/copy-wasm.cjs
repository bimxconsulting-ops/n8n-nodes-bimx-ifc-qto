const fs = require("fs");
const path = require("path");

const src = require.resolve("web-ifc/web-ifc.wasm");
const destDir = path.join(__dirname, "..", "dist", "wasm");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, "web-ifc.wasm"));

console.log("✔ copied web-ifc.wasm → dist/wasm/");

