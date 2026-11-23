'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const APPS_DIR = '/Applications';

// Newest "/Applications/Adobe Illustrator <year>/Adobe Illustrator.app" by year; null if none.
function discover() {
  let names;
  try { names = fs.readdirSync(APPS_DIR); } catch (e) { return null; }
  const found = [];
  for (const n of names) {
    const m = /^Adobe Illustrator.*?(\d{4})/.exec(n);
    if (!m) continue;
    const app = path.join(APPS_DIR, n, 'Adobe Illustrator.app');
    if (fs.existsSync(app)) found.push({ year: parseInt(m[1], 10), app });
  }
  found.sort((a, b) => b.year - a.year);
  return found.length ? found[0].app : null;
}

const SCRIPT = (appPath) =>
  'on run argv\n' +
  'set f to POSIX file (item 1 of argv)\n' +
  'tell application "' + appPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '" to do javascript f with arguments {item 2 of argv, item 3 of argv, item 4 of argv}\n' +
  'end run';

const PERMISSION_MSG =
  'Az Illustrator vezérlése nincs engedélyezve. Engedélyezd a Dunknak: ' +
  'Rendszerbeállítások → Adatvédelem és biztonság → Automatizálás → Dunk → Adobe Illustrator.';

function runJsx(appPath, jsxPath, args, opts) {
  const timeout = (opts && opts.timeoutMs) || 11 * 60 * 1000;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', SCRIPT(appPath), jsxPath].concat(args),
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const text = String(stderr || '') + ' ' + String(err.message || '');
          if (/-1743|not allowed/i.test(text)) {
            const e = new Error(PERMISSION_MSG);
            e.code = 'AUTOMATION_DENIED';
            return reject(e);
          }
          const e = new Error((String(stderr || '').trim() || err.message));
          e.code = err.killed ? 'TIMEOUT' : 'OSASCRIPT_FAILED';
          return reject(e);
        }
        resolve(String(stdout).trim());
      });
  });
}

// Diagnostics: discovery, plus a trivial JSX that returns app.version and checks a Unicode folder round-trip.
async function probe(opts) {
  const os = require('os');
  const lines = [];
  const found = discover();
  lines.push('discovered: ' + (found || '(none)'));
  const app = (opts && opts.appPath) || found;
  lines.push('using: ' + (app || '(none)'));
  if (!app) return lines.join('\n');
  const dir = path.join(os.tmpdir(), 'json-maclane-probe', '\u00c1rv\u00edzt\u0171r\u0151-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const jsx = path.join(dir, 'probe.jsx');
  fs.writeFileSync(jsx, 'var a = arguments; "OK|version=" + app.version + "|unicodeFolderExists=" + (a && a[0] ? new Folder(a[0]).exists : "noarg");', 'utf8');
  const t0 = Date.now();
  try {
    const r = await runJsx(app, jsx, [dir, '', ''], { timeoutMs: 120000 });
    lines.push('jsx result: ' + r + ' (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    lines.push('jsx FAILED [' + e.code + '] ' + e.message);
  }
  try { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  return lines.join('\n');
}

module.exports = { discover, runJsx, probe, PERMISSION_MSG };
