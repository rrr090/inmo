// Assembles the frontend into tauri-ui-dist/ for Tauri to bundle. Tauri won't
// bundle a folder named node_modules, so the files index.html loads from there are
// copied to vendor/ (same sub-paths) and the copied index.html is pointed at them.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'tauri-ui-dist');

function copy(rel, from = ROOT, destRel = rel) {
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(from, rel), dest);
}

fs.rmSync(OUT, { recursive: true, force: true });

for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
  copy(path.join('src', name));
}

// Stylesheets and scripts index.html loads from node_modules, plus the font files they reference.
const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
const toVendor = (rel) => rel.replace(/^node_modules/, 'vendor');
for (const [, ref] of html.matchAll(/(?:href|src)="\.\.\/(node_modules\/[^"]+)"/g)) {
  copy(ref, ROOT, toVendor(ref));
  if (ref.endsWith('.css')) {
    const css = fs.readFileSync(path.join(ROOT, ref), 'utf8');
    for (const [, url] of css.matchAll(/url\((?:'|")?(\.\/[^'")]+)(?:'|")?\)/g)) {
      const fontRel = path.join(path.dirname(ref), url);
      copy(fontRel, ROOT, toVendor(fontRel));
    }
  }
}
const indexPath = path.join(OUT, 'src/index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replaceAll('"../node_modules/', '"../vendor/'));

console.log('build-ui: wrote', path.relative(ROOT, OUT));
