/* Validate staged HTML/CSS assets and static JS imports/fetch paths offline. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../hosting-dist');
let checked = 0;
const missing = new Set();
function check(file, reference) {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference) || reference.includes('${')) return;
  const pathname = reference.split(/[?#]/)[0];
  if (!pathname) return;
  const relative = path.relative(root, file).split(path.sep).join('/');
  const url = new URL(pathname, `https://hosting.invalid/${relative}`);
  const target = path.join(root, decodeURIComponent(url.pathname));
  checked++;
  if (!fs.existsSync(target)) missing.add(`${relative} -> ${pathname}`);
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    const extension = path.extname(file);
    if (!['.html', '.css', '.js'].includes(extension)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const expressions = extension === '.html' ? [/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi]
      : extension === '.css' ? [/url\(\s*["']?([^\s"')]+)["']?\s*\)/gi]
      : [/\bfrom\s*["']([^"']+)["']/g, /\b(?:fetch|import)\(\s*["']([^"']+)["']/g];
    for (const expression of expressions) for (const match of text.matchAll(expression)) check(file, match[1]);
  }
}
for (const required of ['lib/monitoring/Monitoring-Login.html', 'lib/monitoring/Waste-Management.html']) {
  if (!fs.existsSync(path.join(root, required))) throw new Error(`Required page missing: ${required}`);
}
walk(root);
console.log(`Checked ${checked} static local references; ${missing.size} missing.`);
for (const item of missing) console.log(item);
process.exitCode = missing.size ? 1 : 0;
