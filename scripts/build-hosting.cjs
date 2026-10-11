/* Frontend-only staging. No environment loading, dependencies or network access. */
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'hosting-dist');
const directories = ['assets', 'css', 'js', 'lib'];
const extensions = new Set(['.html', '.css', '.js', '.json', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf']);
const textExtensions = new Set(['.html', '.css', '.js', '.json', '.txt', '.svg']);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /"type"\s*:\s*"service_account"/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  /\b(?:ghp_|github_pat_|sk_live_)[A-Za-z0-9_]{16,}/,
  /rtsp:\/\/[^\s<>"']+/i,
  /\b(?:ULTRALYTICS_API_KEY|FIREBASE_SERVICE_ACCOUNT_JSON|CAMERA_RTSP_URL)\s*[:=]\s*["'][^"']+["']/
];
const files = [];
function inspect(directory) {
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Linked frontend directory rejected');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const source = path.join(directory, entry.name);
    const relative = path.relative(root, source);
    // Reject links and private-looking names before reading their contents.
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link rejected: ${relative}`);
    if (entry.name.startsWith('.') || /(?:credential|service[-_]?account|firebase-adminsdk|secret|\.local\.|\.map$|node_modules)/i.test(entry.name)) {
      console.log(`Excluded private/development path: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) { inspect(source); continue; }
    const extension = path.extname(entry.name).toLowerCase();
    if (!entry.isFile() || !extensions.has(extension)) throw new Error(`Unsupported frontend file: ${relative}`);
    if (textExtensions.has(extension)) {
      const text = fs.readFileSync(source, 'utf8');
      if (secretPatterns.some(pattern => pattern.test(text))) throw new Error(`Secret signature rejected: ${relative}`);
    }
    files.push({ source, relative });
  }
}
try {
  // Remove stale output before validation; never delete a linked directory.
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Linked output rejected');
  fs.rmSync(output, { recursive: true, force: true });
  for (const directory of directories) inspect(path.join(root, directory));
  for (const { source, relative } of files) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  console.log(`Staged ${files.length} frontend files in hosting-dist; secret signature checks passed.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
