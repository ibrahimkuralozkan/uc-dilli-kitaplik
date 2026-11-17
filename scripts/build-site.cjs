const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
fs.mkdirSync(output, { recursive: true });
const original = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Keep the old standalone reader byte-for-byte, for a controlled rollout and rollback.
fs.writeFileSync(path.join(output, 'legacy.html'), original);
let scoped = original.replace(/\blocalStorage\b/g, 'window.readerStorage')
  .replace(/\bindexedDB\.open\(/g, 'window.readerDB.open(')
  .replace("e.key===FALLBACK_PREFIX+VOCAB_STATE_KEY", "window.readerStorage.matchesEvent(e,FALLBACK_PREFIX+VOCAB_STATE_KEY)");
scoped = scoped.replace('<head>', '<head><!--READER_ACCOUNT--><script src="/reader-storage.js"></script><link rel="stylesheet" href="/reader-account.css"><script defer src="/reader-session.js"></script>');
if (scoped === original || !scoped.includes('<!--READER_ACCOUNT-->')) throw Error('Reader bootstrap insertion failed');
fs.writeFileSync(path.join(output, 'reader.html'), scoped);
for (const file of fs.readdirSync(path.join(root, 'web'))) fs.copyFileSync(path.join(root, 'web', file), path.join(output, file));
// Protected raw files are only reached through the Worker ASSETS binding.
// Do not retain an old static index.html from the previous build.
if (fs.existsSync(path.join(output, 'index.html'))) fs.unlinkSync(path.join(output, 'index.html'));
console.log('Reader, account pages and scoped local storage assets ready in dist/');
