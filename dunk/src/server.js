'use strict';
const http = require('http');
const pkg = require('../package.json');
const { t, normLang } = require('./i18n');
const { finishBatch, BATCH_ID_RE } = require('./batches');

const PORT = 47800;
const MAX_BODY = 1024 * 1024 * 1024; // 1 GB
const FILE_RE = /^[0-9]{2,3}_[^/\\:]{1,120}\.(pdf|svg|png)$/;

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}
const fail = (res, status, code, message) => sendJson(res, status, { ok: false, error: { code, message } });

function originAllowed(origin) {
  if (origin === undefined || origin === 'null') return true;
  try {
    const h = new URL(origin).hostname.toLowerCase();
    return h === 'figma.com' || h.endsWith('.figma.com');
  } catch (e) { return false; }
}

// Returns an error message, or null when valid.
function validate(body, lang) {
  if (!body || typeof body !== 'object') return t(lang, 'err.BAD_BODY');
  const { manifest, files } = body;
  if (!manifest || typeof manifest !== 'object') return t(lang, 'err.NO_MANIFEST');
  if (!manifest.frame || typeof manifest.frame.name !== 'string' || !manifest.frame.name.trim()) return t(lang, 'err.NO_NAME');
  if (!Array.isArray(manifest.elements)) return t(lang, 'err.NO_ELEMENTS');
  if (!files || typeof files !== 'object' || Array.isArray(files)) return t(lang, 'err.NO_FILES');
  const b = manifest.batch;
  if (b !== undefined) {
    if (!b || typeof b.id !== 'string' || !BATCH_ID_RE.test(b.id) || (b.saveMode !== 'default' && b.saveMode !== 'ask')) return t(lang, 'err.BAD_BATCH');
  }
  for (const k of Object.keys(files)) {
    if (!FILE_RE.test(k)) return t(lang, 'err.BAD_FILENAME', k);
    if (typeof files[k] !== 'string') return t(lang, 'err.BAD_CONTENT', k);
  }
  for (const el of manifest.elements) {
    if (!el || typeof el.file !== 'string' || !Object.prototype.hasOwnProperty.call(files, el.file)) {
      return t(lang, 'err.MISSING_FILE', el && el.file);
    }
  }
  return null;
}

// opts: { settings: {get()}, runJob(payload)->Promise<{aiPath,report}>, getIllustrator()->path|null,
//         getQueueLength()->number, log?, port?, maxBody? }
function createServer(opts) {
  const log = opts.log || (() => {});
  const maxBody = opts.maxBody || MAX_BODY;
  const port = opts.port || PORT;

  function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    const origin = req.headers.origin;
    if (!originAllowed(origin)) {
      log('Rejected origin: ' + origin);
      return fail(res, 403, 'FORBIDDEN_ORIGIN', t(opts.getLang ? opts.getLang() : 'hu', 'err.FORBIDDEN_ORIGIN', origin));
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const pathname = (req.url || '').split('?')[0];

    if (req.method === 'GET' && pathname === '/ping') {
      const ai = opts.getIllustrator ? opts.getIllustrator() : null;
      return sendJson(res, 200, {
        ok: true, app: 'Dunk', version: pkg.version, platform: process.platform,
        illustrator: { found: !!ai, path: ai || null },
        queue: opts.getQueueLength ? opts.getQueueLength() : 0,
        outputDir: opts.settings.get().outputDir,
      });
    }

    if (req.method === 'POST' && pathname === '/frame') return handlePost(req, res, false);
    if (req.method === 'POST' && pathname === '/batch-finish') return handlePost(req, res, true);
    return fail(res, 404, 'BAD_REQUEST', t(opts.getLang ? opts.getLang() : 'hu', 'err.NOT_FOUND', req.method + ' ' + pathname));
  }

  function handlePost(req, res, isFinish) {
    const dl = opts.getLang ? opts.getLang() : 'hu';
    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > maxBody) {
      res.setHeader('Connection', 'close');
      fail(res, 400, 'BAD_REQUEST', t(dl, 'err.TOO_BIG'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBody) {
        aborted = true;
        chunks.length = 0;
        res.setHeader('Connection', 'close');
        fail(res, 400, 'BAD_REQUEST', t(dl, 'err.TOO_BIG'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => { aborted = true; });
    req.on('end', async () => {
      if (aborted) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (e) { return fail(res, 400, 'BAD_REQUEST', t(dl, 'err.BAD_JSON')); }
      chunks.length = 0;
      if (isFinish) return handleFinish(res, body);
      const lang = normLang(body && body.manifest && body.manifest.lang);
      if (body && body.manifest && typeof body.manifest === 'object') body.manifest.lang = lang;
      const problem = validate(body, lang);
      if (problem) return fail(res, 400, 'BAD_REQUEST', problem);
      log('Job: ' + body.manifest.frame.name + ' (' + Object.keys(body.files).length + ' files)');
      try {
        const r = await opts.runJob(body);
        const out = { ok: true, aiPath: r.aiPath, report: r.report };
        if (r.staged) out.staged = true;
        sendJson(res, 200, out);
      } catch (e) {
        const code = e && e.code && /^(ILLUSTRATOR_NOT_FOUND|BAD_REQUEST|JSX_FAILED|TIMEOUT|INTERNAL)$/.test(e.code) ? e.code : 'INTERNAL';
        fail(res, code === 'BAD_REQUEST' ? 400 : 500, code, (e && e.message) || String(e));
      }
    });
  }

  async function handleFinish(res, body) {
    const lang = normLang(body && body.lang);
    try {
      const r = await finishBatch({
        batchId: body && body.batchId, lang,
        outputDir: opts.settings.get().outputDir, pickFolder: opts.pickFolder, log,
      });
      log('batch-finish ' + body.batchId + ' -> ' + r.dir + (r.cancelled ? ' (cancelled, fallback)' : ''));
      sendJson(res, 200, r);
    } catch (e) {
      if (e && e.code === 'BAD_REQUEST') return fail(res, 400, 'BAD_REQUEST', e.message);
      if (e && e.code === 'MOVE_FAILED') {
        return sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: e.message + (opts.getLogPath ? ' ' + t(lang, 'err.details', opts.getLogPath()) : '') }, dir: e.dir, files: e.moved, failed: e.failed });
      }
      fail(res, 500, 'INTERNAL', t(lang, 'err.INTERNAL', (e && e.message) || String(e)));
    }
  }

  const servers = [];
  function listen(host) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.requestTimeout = 0; // the response may take many minutes
      s.headersTimeout = 60000;
      s.timeout = 0;
      s.once('error', reject);
      s.listen(port, host, () => { s.removeListener('error', reject); servers.push(s); resolve(s); });
    });
  }

  return {
    async start() {
      await listen('127.0.0.1'); // fatal if it fails (e.g. EADDRINUSE)
      try { await listen('::1'); }
      catch (e) { log('IPv6 [::1] bind skipped: ' + e.message); }
      log('Listening on port ' + port + ' (' + servers.length + ' socket' + (servers.length > 1 ? 's' : '') + ')');
      return this;
    },
    close() {
      return Promise.all(servers.map((s) => new Promise((r) => { s.close(() => r()); if (s.closeAllConnections) s.closeAllConnections(); })));
    },
  };
}

module.exports = { createServer, PORT, validate, originAllowed };
