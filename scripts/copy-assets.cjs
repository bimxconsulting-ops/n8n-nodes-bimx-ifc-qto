const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "nodes", "BIMX.svg");
const destDir = path.join(__dirname, "..", "dist", "nodes");

if (fs.existsSync(src)) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, "BIMX.svg"));
  console.log("✔ copied icon → dist/nodes/BIMX.svg");
} else {
  console.warn("icon not found:", src);
}
