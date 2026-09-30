// Minimal headless-Chromium driver over the DevTools protocol (Node 22 WebSocket, no deps).
// usage: node tools/browse.mjs <url> <script.json|->  — script: [{eval}|{key, down}|{wait}|{shot}|{click}]
// Prints console messages and exceptions. Example step list:
//   [{"wait":2000},{"click":"#m-drive"},{"key":"ArrowUp","down":true},{"wait":5000},{"shot":"ref/tmp/a.png"}]
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const [url, scriptArg] = process.argv.slice(2);
const steps = JSON.parse(scriptArg === '-' ? readFileSync(0, 'utf8') : scriptArg.startsWith('[') ? scriptArg : readFileSync(scriptArg, 'utf8'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  `--remote-debugging-port=${port}`, '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 150; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') console.log('[console]', m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.log('[exception]', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
});
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(1500);
const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Space: 32, KeyA: 65, KeyZ: 90, KeyC: 67, KeyR: 82, Enter: 13 };
for (const s of steps) {
  if (s.wait) await sleep(s.wait);
  if (s.eval) { const r = await send('Runtime.evaluate', { expression: s.eval, awaitPromise: true, returnByValue: true }); console.log('[eval]', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text)); }
  if (s.click) await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(s.click)}).click()` });
  if (s.key) await send('Input.dispatchKeyEvent', { type: s.down === false ? 'keyUp' : 'rawKeyDown', code: s.key, key: s.key.replace(/^Key/, ''), windowsVirtualKeyCode: KEYS[s.key] });
  if (s.shot) { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(s.shot, Buffer.from(r.result.data, 'base64')); console.log('[shot]', s.shot); }
}
ws.close();
chrome.kill();
process.exit(0);
