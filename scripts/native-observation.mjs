// Fork-only observation. Run solely on a disposable GitHub-hosted virtual desktop.
// No debugger connection, extension, daemon, headless mode or disabled Chrome sandbox.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
assert.notEqual(process.getuid(), 0);
assert.ok(process.env.DISPLAY);
const execute = promisify(execFile);
const chrome = path.resolve(process.env.CHROME);
const out = path.resolve('native-observation');
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'native-observe-'));
const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
const evidence = {
  revision: process.env.GITHUB_SHA,
  browserVersion: (await execute(chrome, ['--version'], { env })).stdout.trim(),
  observationOnly: true,
  cases: [],
};
const save = () => fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
async function observe(name, url, observations) {
  const args = [`--user-data-dir=${path.join(work, name)}`, '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,900', '--accept-lang=ja-JP,ja', url];
  assert.ok(!args.some(arg => /remote-debugging|enable-automation|no-sandbox|headless|load-extension/.test(arg)));
  const log = fs.openSync(path.join(out, `${name}.log`), 'w');
  const child = spawn(chrome, args, { env, detached: true, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const start = Date.now();
  const record = { name, url, args, startedAt: new Date(start).toISOString(), screenshots: [] };
  evidence.cases.push(record);
  save();
  try {
    for (const seconds of observations) {
      await delay(Math.max(0, start + seconds * 1000 - Date.now()));
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, 'Chrome exited before observation');
      record.processArguments = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const file = `${name}-${seconds}s.png`;
      await execute('python3', ['scripts/native-desktop.py', path.join(out, file)],
        { env: { ...env, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }, timeout: 15000 });
      record.screenshots.push({ file, elapsedMs: Date.now() - start });
      save();
    }
  } finally {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await delay(1000);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
}

const fixture = `<!doctype html><meta charset="utf-8"><title>Native platform observation</title>
<pre id="result">Waiting for local platform report</pre><script>
(async () => {
  const report = {languages: navigator.languages, language: navigator.language,
    webdriver: navigator.webdriver, userAgent: navigator.userAgent, graphics: {}};
  for (const kind of ['webgl', 'webgl2']) {
    try {
      const gl = document.createElement('canvas').getContext(kind);
      const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
      report.graphics[kind] = gl ? {available: true, vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: debug && gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        unmaskedRenderer: debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)} : {available: false};
    } catch (error) { report.graphics[kind] = {error: String(error)}; }
  }
  document.querySelector('#result').textContent = JSON.stringify(report, null, 2);
  await fetch('/report', {method: 'POST', body: JSON.stringify(report)});
})();</script>`;
let platformReport;
const server = http.createServer(async (req, res) => {
  if (req.url === '/report' && req.method === 'POST') {
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; assert.ok(body.length < 16384); }
      platformReport = {headers: req.headers, page: JSON.parse(body)};
      fs.writeFileSync(path.join(out, 'platform-report.json'), JSON.stringify(platformReport, null, 2));
      res.end('Recorded');
    } catch { res.writeHead(400); res.end(); }
  } else if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture);
  } else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  await observe('platform', `http://127.0.0.1:${server.address().port}/`, [8]);
  assert.ok(platformReport, 'local fixture did not report; do not infer graphics status');
  // Start directly at the public URL in a separate fresh profile, without a fixture referrer.
  await observe('challenge', 'https://www.scrapingcourse.com/cloudflare-challenge', [16, 32, 64]);
} catch (error) {
  evidence.error = error.stack;
  process.exitCode = 1;
} finally {
  server.close();
  save();
}
