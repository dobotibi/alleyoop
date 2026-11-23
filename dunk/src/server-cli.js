'use strict';
// Headless runner: node src/server-cli.js
// JSON_MACLANE_FAKE=1 swaps Illustrator for a fake (writes dummy .ai + report, returns "OK").
// JSON_MACLANE_FAKE_DELAY=<ms> makes the fake take that long. JSON_MACLANE_PORT overrides the port.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings } = require('./settings');
const { createQueue } = require('./queue');
const { createServer, PORT } = require('./server');
const { cleanupOld } = require('./batches');
const { execFile } = require('child_process');
const illustrator = require('./illustrator');
const { createLogger } = require('./logger');
const { t } = require('./i18n');

// File log: ~/.json-maclane/logs (JSON_MACLANE_LOG_DIR / JSON_MACLANE_LOG_MAX override, mainly for tests).
const logDir = process.env.JSON_MACLANE_LOG_DIR || path.join(os.homedir(), '.json-maclane', 'logs');
const log = createLogger({ dir: logDir, maxBytes: parseInt(process.env.JSON_MACLANE_LOG_MAX || '0', 10) || undefined });
const settings = createSettings(process.env.JSON_MACLANE_SETTINGS || path.join(os.homedir(), '.json-maclane', 'settings.json'));
const fake = process.env.JSON_MACLANE_FAKE === '1';
const jsxPath = path.join(__dirname, 'build-ai.jsx');

const resolveIllustrator = fake
  ? () => '/FAKE/Adobe Illustrator.app'
  : () => settings.get().illustratorPath || illustrator.discover();

const runJsx = fake
  ? async (appPath, jsx, [jobDir, aiPath, reportPath]) => {
      await new Promise((r) => setTimeout(r, parseInt(process.env.JSON_MACLANE_FAKE_DELAY || '0', 10)));
      const manifest = JSON.parse(fs.readFileSync(path.join(jobDir, 'manifest.json'), 'utf8'));
      fs.writeFileSync(aiPath, 'FAKE AI');
      fs.writeFileSync(reportPath, JSON.stringify({ ok: true, aiPath, fake: true, layers: manifest.elements.map((e) => ({ name: e.layerName, kind: e.kind, items: 1 })), warnings: [] }));
      return 'OK';
    }
  : illustrator.runJsx;

// Folder dialog: fake env, or osascript `choose folder` on mac. Returns a path or null (cancel).
const pickFolder = fake
  ? async () => process.env.JSON_MACLANE_FAKE_PICK || null
  : ({ title, defaultPath }) => new Promise((resolve) => {
      if (process.platform !== 'darwin') {
        // Windows: FolderBrowserDialog through PowerShell; title/default path travel in env vars (no quoting).
        const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;' +
          '$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description=$env:JM_TITLE;$d.SelectedPath=$env:JM_DEFAULT;$d.ShowNewFolderButton=$true;' +
          'if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){Write-Output $d.SelectedPath}';
        try { fs.mkdirSync(defaultPath, { recursive: true }); } catch (e) { /* ignore */ }
        const root = process.env.SystemRoot || 'C:\\Windows';
        return execFile(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-STA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
          { env: Object.assign({}, process.env, { JM_TITLE: title, JM_DEFAULT: defaultPath }), windowsHide: false },
          (err, out) => resolve(err ? null : (String(out).trim() || null)));
      }
      const script = 'on run argv\ntry\nreturn POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))\non error\nreturn ""\nend try\nend run';
      try { fs.mkdirSync(defaultPath, { recursive: true }); } catch (e) { /* ignore */ }
      execFile('osascript', ['-e', script, title, defaultPath], (err, out) => {
        const p = err ? '' : String(out).trim().replace(/(.)\/$/, '$1');
        resolve(p || null);
      });
    });

if (process.env.JSON_MACLANE_PROBE !== '1') log('Log file: ' + log.file);
const removed = cleanupOld();
if (removed) log('Removed ' + removed + ' stale staging dir(s)');

const probeMode = process.env.JSON_MACLANE_PROBE === '1';
if (probeMode) {
  illustrator.diagnose({
    appPath: settings.get().illustratorPath || undefined, jsxPath, log, logDir,
    settingsPath: settings.get().illustratorPath, lang: settings.get().lang,
  }).then((file) => { console.log('Probe report: ' + file + '\n'); console.log(fs.readFileSync(file, 'utf8')); process.exit(0); })
    .catch((e) => { console.error('Probe failed: ' + e.message); process.exit(1); });
}

const queue = createQueue({ getSettings: settings.get, resolveIllustrator, runJsx, jsxPath, log, getLogPath: () => log.file });
queue.on('job-start', (e) => log('job-start ' + e.frameName + ' (waiting: ' + e.queued + ')'));
queue.on('job-done', (e) => log('job-done ' + e.frameName + ' -> ' + e.aiPath));
queue.on('job-failed', (e) => log('job-failed ' + e.frameName + ' [' + e.code + '] ' + e.message));

const server = createServer({
  settings, log,
  port: parseInt(process.env.JSON_MACLANE_PORT || String(PORT), 10),
  runJob: (p) => queue.enqueue(p),
  pickFolder,
  getLang: () => settings.get().lang,
  getLogPath: () => log.file,
  getIllustrator: resolveIllustrator,
  getQueueLength: () => queue.length(),
});
if (!probeMode) server.start().catch((e) => {
  const hint = e && e.code === 'EACCES' ? ' ' + t(settings.get().lang, 'dlg.portDenied')
    : e && e.code === 'EADDRINUSE' ? ' ' + t(settings.get().lang, 'dlg.portBusy') : '';
  log('Cannot start: ' + e.message + hint);
  process.exit(1);
});
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
