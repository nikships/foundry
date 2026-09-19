// Attach to an already-running built Electron app. Navigate to the same fixture
// before each measurement; do not profile a dev build or run tests alongside it.
// Usage: node scripts/measure-electron.mjs [CDP port=9251] [seconds=30]
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] ?? 9251);
const seconds = Number(process.argv[3] ?? 30);

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

const base = `http://127.0.0.1:${port}`;
const version = await (await fetch(`${base}/json/version`)).json();
const pages = await (await fetch(`${base}/json/list`)).json();
const page = pages.find((target) => target.type === 'page' && target.url.startsWith('file:'));
if (!page) throw new Error('No built Electron renderer found');
const browser = await connect(version.webSocketDebuggerUrl);
const renderer = await connect(page.webSocketDebuggerUrl);
try {
  await renderer.call('Performance.enable');
  const metrics = async () =>
    Object.fromEntries(
      (await renderer.call('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
    );
  const processes = async () => (await browser.call('SystemInfo.getProcessInfo')).processInfo;
  const before = await metrics();
  const cpuBefore = await processes();
  const start = performance.now();
  await delay(seconds * 1000);
  const after = await metrics();
  const cpuAfter = await processes();
  const elapsed = (performance.now() - start) / 1000;
  const deltas = Object.fromEntries(
    [
      'TaskDuration',
      'ScriptDuration',
      'LayoutDuration',
      'RecalcStyleDuration',
      'LayoutCount',
      'RecalcStyleCount',
    ].map((key) => [key, after[key] - before[key]]),
  );
  const cpu = cpuAfter.map((process) => {
    const previous = cpuBefore.find((p) => p.id === process.id);
    const cpuSeconds = previous ? process.cpuTime - previous.cpuTime : null;
    return {
      type: process.type,
      cpuSeconds,
      percentOfOneCore: cpuSeconds === null ? null : (cpuSeconds / elapsed) * 100,
    };
  });
  console.log(JSON.stringify({ seconds: elapsed, renderer: deltas, processes: cpu }, null, 2));
} finally {
  renderer.close();
  browser.close();
}
