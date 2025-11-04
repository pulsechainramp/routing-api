const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '../src/generated');
const distDir = path.resolve(__dirname, '../dist');
const destDir = path.resolve(distDir, 'generated');

if (!fs.existsSync(srcDir)) {
  console.warn(`Skipping copy-generated: ${srcDir} does not exist`);
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });
