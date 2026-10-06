// Bundles index.html + css + js modules into one self-contained file that works when
// double-clicked (file://), where browsers refuse to load ES modules from separate files.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// dependency order: a module may only use names from modules listed before it
const order = ['solver', 'grid', 'engine', 'tracker', 'merge', 'stats', 'sim', 'store', 'sync', 'capture', 'ui', 'app'];
const js = order
  .map((m) =>
    read(`js/${m}.js`)
      .replace(/^import [^\n]*from ['"][^'"]+['"];?\n/gm, '')
      .replace(/^export (?=(async function|function|class|const|let)\b)/gm, ''),
  )
  .join('\n');
if (/^\s*(import|export)\s/m.test(js)) throw new Error('unhandled import/export left in bundle');

const html = read('index.html')
  .replace(/<link rel="stylesheet" href="css\/style.css">/, () => `<style>\n${read('css/style.css')}</style>`)
  .replace(/<script type="module" src="js\/app.js"><\/script>/, () => `<script type="module">\n${js}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/maple-rj-helper.html'), html);
console.log(`dist/maple-rj-helper.html  ${(html.length / 1024).toFixed(0)} KB`);
