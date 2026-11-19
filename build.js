// Inlines src/core.js into src/app.html -> index.html (single self-contained file). Run: node build.js
const fs = require('fs'), path = require('path');
const core = fs.readFileSync(path.join(__dirname, 'src/core.js'), 'utf8');
if (/<\/script/i.test(core)) throw new Error('core.js must not contain a closing script tag');
const html = fs.readFileSync(path.join(__dirname, 'src/app.html'), 'utf8').replace('/*__CORE__*/', () => core);
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('index.html written,', html.length, 'bytes');
