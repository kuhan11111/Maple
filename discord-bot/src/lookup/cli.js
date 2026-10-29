// Import tables into data/db.json.
//   npm run import -- --dir data/raw                       (monsters.csv / items.csv / drops.csv in a folder)
//   npm run import -- --drops drops.csv --source "來源說明"
// Files may be CSV, TSV (Google Sheets "download as") or JSON arrays.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildDb, tableFromText } from './import.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const files = { monsters: opt('monsters'), items: opt('items'), drops: opt('drops') };
const dir = opt('dir');
if (dir) {
  for (const k of Object.keys(files)) {
    files[k] ??= ['csv', 'tsv', 'json'].map((ext) => join(dir, `${k}.${ext}`)).find(existsSync);
  }
}
if (!Object.values(files).some(Boolean)) {
  console.error('用法:npm run import -- --dir data/raw   或   --monsters m.csv --items i.csv --drops d.csv  [--out data/db.json] [--source "說明"]');
  process.exit(1);
}

const tables = {};
for (const [k, f] of Object.entries(files)) {
  if (!f) continue;
  if (!existsSync(f)) {
    console.error(`找不到檔案:${f}`);
    process.exit(1);
  }
  tables[k] = tableFromText(readFileSync(f, 'utf8'), f);
  console.log(`讀入 ${f}:${tables[k].length} 列`);
}

const { db, warnings } = buildDb(tables, { source: opt('source') ?? '' });
const out = opt('out') ?? 'data/db.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(db, null, 1));
warnings.slice(0, 20).forEach((w) => console.warn(`⚠ ${w}`));
if (warnings.length > 20) console.warn(`⚠ …還有 ${warnings.length - 20} 則警告`);
const c = db.meta.counts;
console.log(`完成 → ${out}:${c.monsters} 隻怪物、${c.items} 個道具、${c.drops} 筆掉落`);
