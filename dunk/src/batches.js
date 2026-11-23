'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');

// On Windows prefer the long (non 8.3) real path of the temp dir; macOS keeps os.tmpdir() unchanged.
function tmpBase() {
  if (process.platform !== 'win32') return os.tmpdir();
  try { return fs.realpathSync.native(os.tmpdir()); } catch (e) { return os.tmpdir(); }
}
const STAGING_ROOT = path.join(tmpBase(), 'json-maclane-batches');

// rm -rf with retries (Windows antivirus / Illustrator can hold handles briefly: EBUSY/EPERM).
function rmrf(d) {
  try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); return true; }
  catch (e) { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BATCH_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const MAX_AGE_MS = 24 * 3600 * 1000;

const batchDir = (id) => path.join(STAGING_ROOT, id);

function cleanupOld() {
  let names = [];
  try { names = fs.readdirSync(STAGING_ROOT); } catch (e) { return 0; }
  let n = 0;
  for (const name of names) {
    const d = path.join(STAGING_ROOT, name);
    try {
      if (Date.now() - fs.statSync(d).mtimeMs > MAX_AGE_MS) { rmrf(d); n++; }
    } catch (e) { /* ignore */ }
  }
  return n;
}

async function moveFile(src, dst) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, dst); return; }
    catch (e) {
      if (e.code === 'EXDEV') { fs.copyFileSync(src, dst); fs.unlinkSync(src); return; }
      if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code) && attempt < 3) { await sleep(300); continue; }
      throw e;
    }
  }
}

// opts: { batchId, lang, outputDir, pickFolder }. Throws {code:'BAD_REQUEST'} when the batch is unknown/empty.
async function finishBatch(opts) {
  const lang = opts.lang;
  const id = opts.batchId;
  const bad = () => Object.assign(new Error(t(lang, 'err.UNKNOWN_BATCH')), { code: 'BAD_REQUEST' });
  if (typeof id !== 'string' || !BATCH_ID_RE.test(id)) throw bad();
  const dir = batchDir(id);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.ai$/i.test(n)); } catch (e) { /* missing */ }
  if (!names.length) throw bad();

  let chosen = null;
  try {
    chosen = opts.pickFolder
      ? await opts.pickFolder({ title: t(lang, 'pick.title', names.length), defaultPath: opts.outputDir, lang })
      : null;
  } catch (e) { chosen = null; }
  let cancelled = !chosen;
  let target = chosen || opts.outputDir;
  try { fs.mkdirSync(target, { recursive: true }); }
  catch (e) {
    if (cancelled) throw e;
    cancelled = true; target = opts.outputDir; fs.mkdirSync(target, { recursive: true });
  }

  const files = [];
  const failed = [];
  for (const n of names) {
    const dst = path.join(target, n);
    try { await moveFile(path.join(dir, n), dst); files.push(dst); }
    catch (e) { failed.push(n); if (opts.log) opts.log('batch move failed: ' + dst + ' [' + e.code + '] ' + e.message); }
  }
  if (failed.length) {
    // keep the unmoved files in staging so the user can retry; report which ones failed
    throw Object.assign(new Error(t(lang, 'err.MOVE_FAILED', failed.join(', '))), { code: 'MOVE_FAILED', moved: files, failed, dir: target });
  }
  rmrf(dir);
  const res = { ok: true, dir: target, files };
  if (cancelled) res.cancelled = true;
  return res;
}

module.exports = { tmpBase, rmrf, STAGING_ROOT, BATCH_ID_RE, batchDir, cleanupOld, finishBatch };
