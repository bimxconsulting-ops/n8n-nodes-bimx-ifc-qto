// kopiert BIMX.svg nach dist/nodes/
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'nodes', 'BIMX.svg');
const dst = path.join(__dirname, '..', 'dist', 'nodes', 'BIMX.svg');

try {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log('Copied BIMX.svg -> dist/nodes/BIMX.svg');
  } else {
    console.log('BIMX.svg not found, skipping copy (ok if icon removed).');
  }
} catch (e) {
  console.error('Copy assets failed:', e);
  process.exit(1);
}
