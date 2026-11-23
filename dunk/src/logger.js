'use strict';
// Plain-Node file logger with size-based rotation. createLogger({dir, maxBytes, keep, echo}) -> log(msg)
// log.file = current log path, log.dir = log directory.
const fs = require('fs');
const path = require('path');

function createLogger(opts) {
  const dir = opts.dir;
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const keep = opts.keep || 3;
  const file = path.join(dir, 'json-maclane.log');
  let size = 0;
  try { fs.mkdirSync(dir, { recursive: true }); size = fs.statSync(file).size; } catch (e) { /* new file */ }

  function rotate() {
    try {
      try { fs.unlinkSync(file + '.' + keep); } catch (e) { /* none */ }
      for (let i = keep - 1; i >= 1; i--) {
        try { fs.renameSync(file + '.' + i, file + '.' + (i + 1)); } catch (e) { /* missing */ }
      }
      fs.renameSync(file, file + '.1');
    } catch (e) { /* ignore */ }
    size = 0;
  }

  function log(msg) {
    const line = new Date().toISOString() + ' ' + msg;
    if (opts.echo !== false) console.log(line);
    try {
      const buf = line + '\n';
      if (size + Buffer.byteLength(buf) > maxBytes && size > 0) rotate();
      fs.appendFileSync(file, buf, 'utf8');
      size += Buffer.byteLength(buf);
    } catch (e) { /* logging must never break a job */ }
  }
  log.file = file;
  log.dir = dir;
  return log;
}

module.exports = { createLogger };
