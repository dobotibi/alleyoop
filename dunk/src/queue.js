'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { t, hasKey } = require('./i18n');
const { batchDir, tmpBase, rmrf } = require('./batches');

const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const KEEP_FAILED = 5;

class JobError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const MAX_PATH_LEN = 240;

// win = apply Windows file-name rules (default: only on win32, so macOS behaviour is unchanged).
function sanitizeName(name, win) {
  if (win === undefined) win = process.platform === 'win32';
  let s = String(name).replace(/[\/\\:*?"<>|\u0000-\u001f\u007f]/g, '_').trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (win) {
    s = s.replace(/[. ]+$/, '');
    if (WIN_RESERVED.test(s.split('.')[0])) s += '_';
  }
  return s || 'frame';
}

// Windows: keep the full <dir>/<name>.ai path <= 240 chars by truncating the name; throws a JobError when impossible.
function fitName(dir, name, lang, win) {
  if (win === undefined) win = process.platform === 'win32';
  if (!win) return name;
  const total = dir.length + 1 + name.length + 3;
  if (total <= MAX_PATH_LEN) return name;
  const allowed = MAX_PATH_LEN - dir.length - 1 - 3;
  if (allowed < 8) throw new JobError('BAD_REQUEST', t(lang, 'err.PATH_TOO_LONG', total));
  return sanitizeName(name.slice(0, allowed), true);
}

// opts: { getSettings, resolveIllustrator() -> path|null, runJsx(appPath, jsxPath, args) -> Promise<string>,
//         jsxPath, timeoutMs? }
function createQueue(opts) {
  const ee = new EventEmitter();
  const timeoutMs = opts.timeoutMs || JOB_TIMEOUT_MS;
  const pending = [];
  let running = false;
  let current = null;
  const failedDirs = [];

  const qlog = opts.log || (() => {});

  async function execute(payload) {
    const { manifest, files } = payload;
    const settings = opts.getSettings();
    const lang = manifest.lang;
    const staged = !!(manifest.batch && manifest.batch.saveMode === 'ask');
    const appPath = opts.resolveIllustrator();
    if (!appPath) throw new JobError('ILLUSTRATOR_NOT_FOUND', t(lang, 'err.ILLUSTRATOR_NOT_FOUND'));

    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const jobDir = path.join(tmpBase(), 'json-maclane', stamp);
    qlog('job ' + stamp + ' start: ' + manifest.frame.name + ' (' + Object.keys(files).length + ' files, dir ' + jobDir + ')');
    fs.mkdirSync(jobDir, { recursive: true });
    let ok = false;
    try {
      for (const name of Object.keys(files)) {
        if (path.basename(name) !== name) throw new JobError('BAD_REQUEST', t(lang, 'err.BAD_FILENAME', name));
        fs.writeFileSync(path.join(jobDir, name), Buffer.from(files[name], 'base64'));
      }
      fs.writeFileSync(path.join(jobDir, 'manifest.json'), JSON.stringify(manifest, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'), 'utf8'); // ExtendScript (ES3) eval treats raw U+2028/U+2029 as line breaks

      const outDir = staged ? batchDir(manifest.batch.id) : settings.outputDir;
      fs.mkdirSync(outDir, { recursive: true });
      const aiPath = path.join(outDir, fitName(outDir, sanitizeName(manifest.frame.name), lang) + '.ai');
      const reportPath = path.join(jobDir, 'report.json');

      let timer;
      let result;
      try {
        result = await Promise.race([
          opts.runJsx(appPath, opts.jsxPath, [jobDir, aiPath, reportPath], { timeoutMs: timeoutMs + 60000, log: qlog }),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new JobError('TIMEOUT', t(lang, 'err.TIMEOUT', Math.round(timeoutMs / 60000)))), timeoutMs);
          }),
        ]);
      } catch (e) {
        if (e instanceof JobError) throw e;
        qlog('job ' + stamp + ' adapter error [' + e.code + '] ' + e.message + (e.stderr ? '\n--- stderr ---\n' + e.stderr + '\n--- end stderr ---' : ''));
        const detail = { reason: e.code, stderr: e.stderr };
        if (e.code === 'TIMEOUT') throw new JobError('TIMEOUT', t(lang, 'err.TIMEOUT', Math.round(timeoutMs / 60000)), detail);
        // any adapter code with a translated string (AUTOMATION_DENIED, COM_*, ILLUSTRATOR_BUSY, POWERSHELL_BLOCKED, ...)
        if (e.code && hasKey('err.' + e.code)) throw new JobError(e.code === 'ILLUSTRATOR_NOT_FOUND' ? 'ILLUSTRATOR_NOT_FOUND' : 'JSX_FAILED', t(lang, 'err.' + e.code), detail);
        throw new JobError('JSX_FAILED', e.message, detail);
      } finally {
        clearTimeout(timer);
      }

      let report = null;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch (e) { /* no report */ }

      result = String(result || '').trim();
      if (result.indexOf('ERR:') === 0) throw new JobError('JSX_FAILED', result.slice(4).trim() || t(lang, 'err.JSX_UNKNOWN'), { report });
      if (result !== 'OK') throw new JobError('JSX_FAILED', t(lang, 'err.JSX_UNEXPECTED', result.slice(0, 300)), { report });
      if (!fs.existsSync(aiPath)) throw new JobError('JSX_FAILED', t(lang, 'err.JSX_NOFILE', aiPath), { report });
      ok = true;
      qlog('job ' + stamp + ' done: ' + aiPath);
      return staged ? { aiPath, report, staged: true } : { aiPath, report };
    } finally {
      if (ok) rmrf(jobDir);
      else {
        failedDirs.push(jobDir);
        while (failedDirs.length > KEEP_FAILED) rmrf(failedDirs.shift());
      }
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    while (pending.length) {
      const job = pending.shift();
      current = job;
      const frameName = job.payload.manifest.frame.name;
      ee.emit('job-start', { frameName, queued: pending.length });
      try {
        const res = await execute(job.payload);
        ee.emit('job-done', { frameName, aiPath: res.aiPath, report: res.report });
        job.resolve(res);
      } catch (e) {
        const err = e instanceof JobError ? e : new JobError('INTERNAL', e && e.message ? e.message : String(e));
        qlog('job failed: ' + frameName + ' [' + err.code + (err.reason ? '/' + err.reason : '') + '] ' + err.message);
        if (opts.getLogPath && err.code !== 'BAD_REQUEST') err.message += ' ' + t(job.payload.manifest.lang, 'err.details', opts.getLogPath());
        ee.emit('job-failed', { frameName, code: err.code, message: err.message });
        job.reject(err);
      }
      current = null;
    }
    running = false;
  }

  ee.enqueue = (payload) => new Promise((resolve, reject) => {
    pending.push({ payload, resolve, reject });
    pump();
  });
  // total jobs not finished (running + waiting)
  ee.length = () => pending.length + (current ? 1 : 0);
  ee.currentFrame = () => (current ? current.payload.manifest.frame.name : null);
  ee.failedDirs = () => failedDirs.slice();
  return ee;
}

module.exports = { createQueue, JobError, sanitizeName, fitName };
