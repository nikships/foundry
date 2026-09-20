// Attach to an already-running built Electron app. Navigate to the same fixture
// before each measurement; do not profile a dev build or run tests alongside it.
// Usage: node scripts/measure-electron.mjs [CDP port=9251] [seconds=30]
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.argv[2] ?? 9251);
const seconds = Number(process.argv[3] ?? 30);
const timeoutMs = 5_000;
const maxTimerSeconds = 2_147_483_647 / 1_000;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`CDP port must be an integer from 1 to 65535; received ${process.argv[2]}`);
}
if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maxTimerSeconds) {
  throw new Error(
    `Duration must be a positive finite number no greater than ${maxTimerSeconds} seconds; received ${process.argv[3]}`,
  );
}

async function connect(url) {
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out connecting to CDP at ${url}`)),
        timeoutMs,
      );
      const settle = (callback) => (event) => {
        clearTimeout(timer);
        callback(event);
      };
      socket.addEventListener('open', settle(resolve), { once: true });
      socket.addEventListener(
        'error',
        settle(() => reject(new Error(`CDP connection failed: ${url}`))),
        {
          once: true,
        },
      );
      socket.addEventListener(
        'close',
        settle((event) =>
          reject(new Error(`CDP connection closed during handshake (${event.code})`)),
        ),
        { once: true },
      );
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  let id = 0;
  const pending = new Map();
  const failPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  socket.addEventListener('message', ({ data }) => {
    let message;
    try {
      message = JSON.parse(String(data));
      if (!message || typeof message !== 'object') throw new Error('packet is not an object');
    } catch (error) {
      failPending(new Error(`Malformed CDP packet from ${url}: ${error.message}`));
      socket.close();
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const request = pending.get(message.id);
    if (!request) {
      failPending(new Error(`Unexpected CDP response id ${String(message.id)} from ${url}`));
      socket.close();
      return;
    }
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', ({ code, reason }) => {
    failPending(new Error(`CDP connection closed (${code}${reason ? `: ${reason}` : ''}): ${url}`));
  });
  socket.addEventListener('error', () => {
    failPending(new Error(`CDP connection error: ${url}`));
  });
  return {
    call(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error(`Cannot call ${method}: CDP connection is not open`));
      }
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for CDP method ${method}`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id: requestId, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(new Error(`Could not send CDP method ${method}: ${error.message}`));
        }
      });
    },
    // Native WebSocket.close() returns void. Pending calls are settled by the close event.
    close: () => socket.close(),
  };
}

async function discover(path) {
  const url = `${base}${path}`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Could not reach CDP discovery endpoint ${url}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`CDP discovery endpoint ${url} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`CDP discovery endpoint ${url} returned invalid JSON: ${error.message}`);
  }
}

const base = `http://127.0.0.1:${port}`;
const version = await discover('/json/version');
const pages = await discover('/json/list');
if (typeof version?.webSocketDebuggerUrl !== 'string') {
  throw new Error('CDP /json/version response did not include webSocketDebuggerUrl');
}
if (!Array.isArray(pages)) throw new Error('CDP /json/list response was not an array');
const page = pages.find(
  (target) =>
    target?.type === 'page' && typeof target.url === 'string' && target.url.startsWith('file:'),
);
if (!page) throw new Error('No built Electron renderer found');
if (typeof page.webSocketDebuggerUrl !== 'string') {
  throw new Error(`Selected renderer target ${page.url} did not include webSocketDebuggerUrl`);
}
console.error(`Selected renderer target: ${page.url}`);
let browser;
let renderer;
try {
  browser = await connect(version.webSocketDebuggerUrl);
  renderer = await connect(page.webSocketDebuggerUrl);
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
  const cpu = cpuAfter.map((processInfo) => {
    const previous = cpuBefore.find((candidate) => candidate.id === processInfo.id);
    const cpuSeconds = previous ? processInfo.cpuTime - previous.cpuTime : null;
    return {
      type: processInfo.type,
      cpuSeconds,
      percentOfOneCore: cpuSeconds === null ? null : (cpuSeconds / elapsed) * 100,
    };
  });
  console.log(JSON.stringify({ seconds: elapsed, renderer: deltas, processes: cpu }, null, 2));
} finally {
  renderer?.close();
  browser?.close();
}
