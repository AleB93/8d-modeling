// End-to-end WebMCP check against real Chrome, acting like a browser agent.
// Launches an isolated headless Chrome (temporary profile, WebMCP flag on — your normal Chrome is untouched),
// opens 8D modeling, discovers tools via the DevTools `WebMCP` domain and invokes them.
//
//   npm run dev            # in another terminal
//   npm run test:webmcp    # optional: MODELING8D_URL=http://localhost:5173/ CHROME_PATH=/path/to/chrome
//
// Requires Node 22+ (global fetch/WebSocket) and Chrome with WebMCP (157 verified).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.env.MODELING8D_URL ?? 'http://localhost:5173/';
const PORT = 9300 + Math.floor(Math.random() * 500);
const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome SxS\\Application\\chrome.exe`,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) { console.error('Chrome not found; set CHROME_PATH'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

try { const r = await fetch(URL_); check('8D modeling dev server reachable', r.ok, URL_); }
catch { check('8D modeling dev server reachable', false, `${URL_} (run npm run dev)`); process.exit(1); }

const profile = mkdtempSync(join(tmpdir(), '8d-modeling-webmcp-'));
writeFileSync(join(profile, 'Local State'), JSON.stringify({ browser: { enabled_labs_experiments: ['enable-webmcp-testing@1'] } }));
const chrome = spawn(chromePath, ['--headless=new', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch { /* gone */ } setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); };
process.on('exit', cleanup);

let targets;
for (let i = 0; i < 50 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); } }
const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
console.log(`Chrome: ${version.Browser}\n`);

const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map(); const events = [];
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method?.startsWith('WebMCP.')) events.push(msg);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Page.enable');
await send('Page.navigate', { url: URL_ });
await sleep(2500);
const frameId = (await send('Page.getFrameTree')).result.frameTree.frame.id;

const page = await evalJs(`return { ctx: !!(document.modelContext ?? navigator.modelContext), dot: document.querySelector('.agentpill')?.dataset.webmcp }`);
check('Browser exposes WebMCP (modelContext)', page?.ctx, page?.ctx ? '' : 'flag not active in this Chrome build');
check('Status dot is green', page?.dot === 'ok', `dot=${page?.dot}`);

const en = await send('WebMCP.enable');
check('DevTools WebMCP domain available', !en.error, en.error?.message ?? '');
await sleep(1500);
const tools = events.filter((e) => e.method === 'WebMCP.toolsAdded').flatMap((e) => e.params.tools ?? []).filter((t) => t.name.startsWith('modeling8d_'));
check('Agent discovers 8D modeling tools', tools.length === 17, `${tools.length} found`);

const invoke = async (toolName, input) => {
  events.length = 0;
  const r = await send('WebMCP.invokeTool', { frameId, toolName, input });
  for (let i = 0; i < 50 && !events.some((e) => e.method === 'WebMCP.toolResponded'); i++) await sleep(100);
  const p = events.find((e) => e.method === 'WebMCP.toolResponded')?.params;
  const out = typeof p?.output === 'string' ? (() => { try { return JSON.parse(p.output); } catch { return p.output; } })() : p?.output;
  return { status: r.error ? 'InvokeError' : p?.status, output: out, error: r.error?.message ?? p?.exception?.description?.split('\n')[0] };
};

const scene = await invoke('modeling8d_get_scene', {});
check('Read scene', scene.status === 'Completed' && Array.isArray(scene.output?.nodes), `${scene.output?.nodes?.length} nodes`);
const base = await invoke('modeling8d_simulate', { multiplier: 1, seconds: 5 });
const x2 = await invoke('modeling8d_simulate', { multiplier: 2, seconds: 5 });
check('Inputs reach tools (2× traffic doubles req/s)', x2.output?.totals?.requestsPerSec === 2 * base.output?.totals?.requestsPerSec,
  `${base.output?.totals?.requestsPerSec} → ${x2.output?.totals?.requestsPerSec} req/s`);
const add = await invoke('modeling8d_add_nodes', { nodes: [{ kind: 'cache', label: '__webmcp_check__' }] });
check('Write tool works', add.status === 'Completed' && add.output?.created?.length === 1);
const undo = await invoke('modeling8d_undo', {});
const after = await invoke('modeling8d_get_scene', {});
check('Undo reverts agent edit', undo.output?.undone === 1 && !after.output?.nodes?.some((n) => n.label === '__webmcp_check__'));
const bad = await invoke('modeling8d_connect', { edges: [{ from: '__missing__', to: '__missing2__' }] });
check('Errors reported as status "Error"', bad.status === 'Error', bad.error ?? bad.status);

ws.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll WebMCP checks passed');
process.exit(failures ? 1 : 0);
