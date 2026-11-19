// Headless Chrome smoke test of index.html with mocked iOS sensor APIs (CDP over Node's built-in WebSocket).
// Run: node test/smoke.mjs   (needs google-chrome / chromium on PATH; set CHROME=/path to override)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const external = [];
const server = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!f.startsWith(root) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const chrome = process.env.CHROME || 'google-chrome';
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-'));
const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${prof}`,
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((res, rej) => {
  let buf = ''; proc.stderr.on('data', (d) => { buf += d; const m = buf.match(/ws:\/\/[^\s]+/); if (m) res(m[0]); });
  setTimeout(() => rej(new Error('chrome did not start')), 15000);
});
const browserWs = new WebSocket(wsUrl);
await new Promise((r) => browserWs.addEventListener('open', r));
let mid = 0; const pending = new Map(); const listeners = [];
browserWs.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
  else listeners.forEach((f) => f(d));
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); browserWs.send(JSON.stringify({ id, method, params, sessionId })); });

const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failed++; };

try {
  await send('Browser.grantPermissions', { origin: base.slice(0, -1), permissions: ['geolocation', 'audioCapture', 'videoCapture'] });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  const consoleErrors = [];
  listeners.push((d) => {
    if (d.sessionId !== sessionId) return;
    if (d.method === 'Runtime.exceptionThrown') consoleErrors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') consoleErrors.push(d.params.args.map((a) => a.value || a.description).join(' '));
    if (d.method === 'Network.requestWillBeSent') { const u = d.params.request.url; if (!u.startsWith(base) && !/^(data|blob|about|chrome)/.test(u)) external.push(u); }
  });
  await S('Runtime.enable'); await S('Network.enable'); await S('Page.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true });
  await S('Emulation.setGeolocationOverride', { latitude: 37.7749, longitude: -122.4194, accuracy: 12 });
  // Mock the iOS-only permission APIs + compass heading, and count requestPermission calls.
  await S('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__perm = [];
    DeviceMotionEvent.requestPermission = function(){ window.__perm.push('motion:' + (navigator.userActivation ? navigator.userActivation.isActive : '?')); return Promise.resolve('granted'); };
    DeviceOrientationEvent.requestPermission = function(){ window.__perm.push('orient'); return Promise.resolve('granted'); };
  ` });
  const ev = async (expr) => { const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const wait = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };

  await S('Page.navigate', { url: base + 'index.html' });
  check('page boots and ledger opens (IndexedDB)', await wait('!!(window.__genie && window.__genie.ledger)'));
  check('sensor list rendered (21 rows)', await wait('document.querySelectorAll("#sensors li").length >= 21', 3000));

  // Real tap (CDP Input) so user activation is genuine.
  const box = await ev('(()=>{const r=document.querySelector("#wake").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  for (const type of ['mousePressed', 'mouseReleased']) await S('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  check('requestPermission called inside the tap (user activation active)', await wait('window.__perm.length>=2 && window.__perm[0]==="motion:true"'), JSON.stringify(await ev('window.__perm')));

  // Feed devicemotion / deviceorientation events in real time: still (2.2 s) -> 0.6 m free fall -> impact -> rest (2 s)
  await ev(`new Promise((res) => {
    const G=9.80665; const ffMs = Math.sqrt(2*0.6/G)*1000; let t0 = performance.now();
    const iv = setInterval(() => {
      const tm = performance.now() - t0; let z;
      if (tm < 2200) z = 1; else if (tm < 2200 + ffMs) z = 0.05; else if (tm < 2200 + ffMs + 20) z = 5.5; else if (tm < 2200+ffMs+200) z = 1 + 0.8*Math.cos(tm/7); else z = 1;
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 0.01*Math.sin(tm), y: 0.02, z: -z*G }, acceleration: {x:0,y:0,z:0}, rotationRate: { alpha: 1, beta: 2, gamma: 3 }, interval: 16 }));
      const o = new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 20, gamma: 30, absolute: false });
      Object.defineProperty(o, 'webkitCompassHeading', { value: 123.4 }); Object.defineProperty(o, 'webkitCompassAccuracy', { value: 10 });
      window.dispatchEvent(o);
      if (tm > 2200 + ffMs + 2400) { clearInterval(iv); res(); }
    }, 16);
  })`);
  check('live drop detected -> OBSERVED/DERIVED/INFERRED in ledger', await wait('window.__genie.ledger.byClass("INFERRED").length>=1', 8000),
    JSON.stringify(await ev('window.__genie.ledger.entries().map(e=>e.class+":"+e.source)')));
  const inf = await ev('(()=>{const e=window.__genie.ledger.byClass("INFERRED")[0];return e&&{h:e.data.hypothesis,c:e.confidence,prov:e.provenance,alts:e.data.alternatives.length}})()');
  check('INFERRED has confidence, provenance and competing explanations', !!inf && inf.c > 0 && inf.c < 1 && inf.prov.length === 2 && inf.alts >= 3, JSON.stringify(inf));
  const ctx = await ev('window.__genie.ledger.byClass("OBSERVED")[0].data.context');
  check('OBSERVED window carries synchronized context (heading, geo, sound, brightness)', ctx && ctx.headingDeg === 123.4 && ctx.geo && ctx.soundDbfs != null, JSON.stringify({ h: ctx?.headingDeg, geo: ctx?.geo, db: ctx?.soundDbfs, lum: ctx?.brightness }));
  const statuses = await ev('Object.fromEntries([...document.querySelectorAll("#sensors li")].map(l=>[l.dataset.k,l.dataset.status]))');
  check('sensor statuses: motion/compass/geo/mic active; barometer unsupported', ['accel', 'gyro', 'orient', 'compass', 'geo', 'mic'].every((k) => statuses[k] === 'active') && statuses.baro === 'unsupported', JSON.stringify(statuses));
  check('camera brightness stream (fake device)', await wait('document.querySelector("#sensors li[data-k=cam]").dataset.status==="active"', 6000), statuses.cam);
  check('event verified by immediate replay (gold mark)', await wait('document.querySelectorAll("#ledger .verified").length>=3', 4000));

  await ev('document.querySelector("#sim").click()');
  check('simulate drop adds a second event chain', await wait('window.__genie.ledger.byClass("INFERRED").length===2', 4000));
  await ev('document.querySelector("#snap").click()');
  check('snapshot stored as OBSERVED', await wait('window.__genie.ledger.entries().some(e=>e.kind==="sensor.snapshot")', 3000));

  await ev('document.querySelector("#replay").click()');
  check('replay button: all windows match', await wait('window.__genie.lastReplay && window.__genie.lastReplay.checked===2 && window.__genie.lastReplay.matched===2', 3000), await ev('document.querySelector("#banner").textContent'));

  const before = await ev('window.__genie.ledger.size');
  await ev('document.querySelector("#fw").click()');
  await wait('/Firewall test/.test(document.querySelector("#banner").textContent)', 3000);
  const fwMsg = await ev('document.querySelector("#banner").textContent');
  check('in-app firewall test: all 4 illegal writes blocked, ledger unchanged', !/ACCEPTED/.test(fwMsg) && (fwMsg.match(/blocked/g) || []).length === 4 && (await ev('window.__genie.ledger.size')) === before, fwMsg);

  await ev('document.querySelector("#verify").click()');
  check('verify chain against IndexedDB', await wait('/Chain OK/.test(document.querySelector("#banner").textContent)', 3000));

  // Reload: ledger must come back from IndexedDB and re-verify
  const head = await ev('window.__genie.ledger.head');
  const exported = await ev('JSON.stringify(window.__genie.ledger.exportJSON())');
  await S('Page.reload');
  check('persisted ledger reloads from IndexedDB with same head', await wait(`window.__genie && window.__genie.ledger && window.__genie.ledger.head===${JSON.stringify(head)}`));

  // Wipe with confirm() auto-accepted
  await ev('window.confirm = () => true; document.querySelector("#wipe").click()');
  check('verifiable deletion: IndexedDB count 0 + receipt', await wait('/post-count 0/.test(document.querySelector("#receipt").textContent)', 3000), await ev('document.querySelector("#receipt").textContent'));
  const idbCount = await ev(`new Promise(r=>{const q=indexedDB.open('axis-genie');q.onsuccess=()=>{const c=q.result.transaction('ledger').objectStore('ledger').count();c.onsuccess=()=>r(c.result)}})`);
  check('independent IndexedDB count after delete is 0', idbCount === 0, String(idbCount));

  // Import the exported JSON back (via the same code path as the file picker)
  await ev(`(()=>{const f=new File([${JSON.stringify(exported)}],'l.json',{type:'application/json'});const dt=new DataTransfer();dt.items.add(f);const i=document.querySelector('#import');i.files=dt.files;i.dispatchEvent(new Event('change'));})()`);
  check('import restores and re-verifies the exported ledger', await wait(`window.__genie.ledger.head===${JSON.stringify(head)} && /Imported/.test(document.querySelector("#banner").textContent)`, 4000), await ev('document.querySelector("#banner").textContent'));

  await S('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(root, 'test', 'smoke-screenshot.png'), Buffer.from(r.data, 'base64')));
  check('no uncaught page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
  check('no requests to any other host', external.length === 0, external.join(', '));
} catch (e) { check('smoke run', false, e.stack); }
finally {
  console.log(results.join('\n'));
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  proc.kill(); server.close(); await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); }); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
