'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Picks the platform adapter. Adapter shape:
//   discover() -> string | [{year, exe, progId}] | null   (mac: .app path; win: candidates, newest first)
//   runJsx(appPath, jsxPath, args, {timeoutMs, log}) -> Promise<string>   stdout trimmed ("OK" / "ERR:...")
//   probe({appPath, jsxPath, log, lang}) -> Promise<string>   human-readable diagnostics report
const adapter = process.platform === 'win32' ? require('./win') : require('./mac');

// Always a plain path string (or null), whatever shape the adapter's discover() returns.
function discover() {
  const d = adapter.discover();
  if (Array.isArray(d)) return d.length ? (d[0].exe || d[0].path || null) : null;
  return d || null;
}

// Runs the adapter probe and writes <logDir>/probe-<timestamp>.txt. Returns the file path.
async function diagnose(opts) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const head = [
    'Dunk diagnostics ' + new Date().toISOString(),
    'platform: ' + process.platform + ' ' + os.release() + ' ' + process.arch,
    'node: ' + process.versions.node + (process.versions.electron ? ' / electron ' + process.versions.electron : ''),
    'illustratorPath (settings): ' + (opts.settingsPath || '(auto)'),
    'jsxPath: ' + opts.jsxPath + ' exists=' + fs.existsSync(opts.jsxPath),
    '',
  ].join('\n');
  let body;
  try {
    if (typeof adapter.probe !== 'function') body = '(this adapter has no probe())';
    else {
      const r = await adapter.probe({ appPath: opts.appPath, jsxPath: opts.jsxPath, log: opts.log, lang: opts.lang });
      body = typeof r === 'string' ? r : (r && r.text) ? r.text : JSON.stringify(r, null, 2);
    }
  } catch (e) {
    body = 'PROBE FAILED [' + e.code + '] ' + e.message + (e.stderr ? '\n--- stderr ---\n' + e.stderr : '');
  }
  fs.mkdirSync(opts.logDir, { recursive: true });
  const file = path.join(opts.logDir, 'probe-' + ts + '.txt');
  fs.writeFileSync(file, head + body + '\n', 'utf8');
  return file;
}

module.exports = { discover, runJsx: adapter.runJsx, probe: adapter.probe, diagnose, adapter };
