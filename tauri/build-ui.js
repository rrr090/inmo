// Assembles the frontend for Tauri into tauri-ui-dist/. Tauri won't bundle a
// folder named node_modules, so the files index.html loads from there are copied
// to vendor/ (same sub-paths) and the copied index.html is pointed at them.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tauri-ui-dist');

// Electron-only files that the Tauri build replaces.
const SKIP = new Set(['index.js', 'preload.js', 'mini-preload.js']);

function copy(rel, from = ROOT, destRel = rel) {
  const dest = path.join(OUT, destRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(from, rel), dest);
}

function inject(rel, before, tag) {
  const file = path.join(OUT, rel);
  const html = fs.readFileSync(file, 'utf8');
  if (!html.includes(before)) throw new Error(`build-ui: "${before}" not found in ${rel}`);
  fs.writeFileSync(file, html.replace(before, `${tag}\n  ${before}`));
}

fs.rmSync(OUT, { recursive: true, force: true });

for (const name of fs.readdirSync(path.join(ROOT, 'src'))) {
  if (!SKIP.has(name)) copy(path.join('src', name));
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

copy('tauri-api.js', __dirname);
fs.renameSync(path.join(OUT, 'tauri-api.js'), path.join(OUT, 'src/tauri-api.js'));
copy('tauri-mini.js', __dirname);
fs.renameSync(path.join(OUT, 'tauri-mini.js'), path.join(OUT, 'src/tauri-mini.js'));

inject('src/index.html', '<script type="module" src="stuff.js"></script>', '<script src="tauri-api.js"></script>');
inject('src/mini-widget.html', '<script>', '<script src="tauri-mini.js"></script>');

console.log('build-ui: wrote', path.relative(ROOT, OUT));
