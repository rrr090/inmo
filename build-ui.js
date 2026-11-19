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
    // WebView2 reads woff2, so the legacy .woff fallbacks are dropped from the copy.
    const slim = css.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
    fs.writeFileSync(path.join(OUT, toVendor(ref)), slim);
    for (const [, url] of slim.matchAll(/url\((?:'|")?(\.\/[^'")]+)(?:'|")?\)/g)) {
      const fontRel = path.join(path.dirname(ref), url);
      copy(fontRel, ROOT, toVendor(fontRel));
    }
  }
}
// Loaded on demand by analytics.js rather than by a tag in index.html.
copy('node_modules/chart.js/dist/chart.umd.min.js', ROOT, 'vendor/chart.js/dist/chart.umd.min.js');
const indexPath = path.join(OUT, 'src/index.html');
fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replaceAll('"../node_modules/', '"../vendor/'));

console.log('build-ui: wrote', path.relative(ROOT, OUT));

// Release builds (`--minify`, from tauri.conf.json's beforeBuildCommand) bundle the
// ES modules behind app.js into one file and minify the scripts and stylesheet.
// Dev builds skip this so the code stays readable in the devtools.
if (process.argv.includes('--minify')) {
  const esbuild = require('esbuild');
  const srcOut = path.join(OUT, 'src');
  const pages = fs.readdirSync(srcOut).filter((n) => n.endsWith('.html'));
  const loadedByTag = new Set();
  for (const page of pages) {
    const text = fs.readFileSync(path.join(srcOut, page), 'utf8');
    for (const [, file] of text.matchAll(/<script[^>]*\ssrc="([^"/]+\.js)"/g)) loadedByTag.add(file);
  }

  // The modules app.js imports are inlined, so their separate copies can go.
  const bundle = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src/app.js')],
    outfile: path.join(srcOut, 'app.js'),
    bundle: true,
    minify: true,
    format: 'esm',
    target: 'es2022',
    allowOverwrite: true,
    metafile: true,
    logLevel: 'warning',
  });
  for (const input of Object.keys(bundle.metafile.inputs)) {
    const name = path.basename(input);
    if (name !== 'app.js' && !loadedByTag.has(name)) fs.rmSync(path.join(srcOut, name), { force: true });
  }

  // Plain scripts that are loaded by a tag, not imported.
  for (const name of loadedByTag) {
    const file = path.join(srcOut, name);
    fs.writeFileSync(file, esbuild.transformSync(fs.readFileSync(file, 'utf8'), { minify: true, target: 'es2022' }).code);
  }
  const css = path.join(srcOut, 'index.css');
  fs.writeFileSync(css, esbuild.transformSync(fs.readFileSync(css, 'utf8'), { loader: 'css', minify: true }).code);
  console.log('build-ui: minified');
}
