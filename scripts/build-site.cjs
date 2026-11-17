const fs = require('node:fs');
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('index.html', 'dist/index.html');
console.log('Kitaplik static files ready in dist/');
