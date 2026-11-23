'use strict';
/*
 * Windows Illustrator adapter (CONTRACT.md section 11). Written on macOS, NEVER run on Windows yet.
 * Target: Windows PowerShell 5.1 (no `??`, no ternary, no PowerShell 7 features).
 *
 * Sources / verification status
 *  VERIFIED   Marshal.GetActiveObject(progID) returns the running instance from the ROT, throws COMException
 *             if none; .NET Framework only (not in .NET Core, so we must run Windows PowerShell 5.1, not pwsh):
 *             https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.marshal.getactiveobject
 *  VERIFIED   CreateObject("Illustrator.Application") starts Illustrator invisibly; unversioned ProgID = latest
 *             install; versioned ProgIDs documented only up to CC2017 (.CS6, .CC2017 ...):
 *             https://ai-scripting.docsforadobe.dev/scripting/launching/
 *  VERIFIED   RPC_E_CALL_REJECTED 0x80010001 "Call was rejected by callee" and RPC_E_SERVERCALL_RETRYLATER
 *             0x8001010A are the "server busy" codes; the usual cure is retrying:
 *             https://learn.microsoft.com/en-us/windows/win32/api/objidl/nf-objidl-imessagefilter-retryrejectedcall
 *  VERIFIED (as a report) DoJavaScriptFile(file, [args], [mode]) exists; a user reported PowerShell
 *             New-Object -ComObject Illustrator.Application + DoJavaScript failing with TYPE_E_LIBNOTREGISTERED
 *             (0x8002801D) on Illustrator 2019, and waiting ~10 s after launch in VBScript threads:
 *             https://windows-hexerror.linestarve.com/q/so52997729-how-to-kick-off-extendscript-jsx-script-from-powershell
 *             https://community.adobe.com/t5/illustrator-discussions/how-to-pass-arguments-from-visual-basic-to-javascript/m-p/2153469
 *  UNVERIFIED (needs a Windows PC with Illustrator): ProgID names for 2024-2026 (we resolve them from the
 *             registry via CLSID -> LocalServer32 instead of hardcoding); that Illustrator is registered in the
 *             ROT so GetActiveObject works; that DoJavaScriptFile accepts one argument from PowerShell's COM
 *             adapter (optional params omitted); that $.evalFile returns the evaluated value (we also read
 *             result.txt); the install folder layout; 8.3 / OneDrive / accented paths through ExtendScript;
 *             exact HRESULTs in the mapping table below; `reg query` output on non-English Windows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MIN_YEAR = 2024;
const MAX_YEAR = 2026;
const PLAIN_PROGID = 'Illustrator.Application';
const BOM = '\uFEFF';
const BUSY_RETRIES = 3;
const BUSY_BACKOFF_MS = 5000;

// ---------- small helpers -------------------------------------------------------------------------

function sysRoot() { return process.env.SystemRoot || process.env.windir || 'C:\\Windows'; }
function powershellPath() {
  return path.win32.join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function regExePath() { return path.win32.join(sysRoot(), 'System32', 'reg.exe'); }

function normExe(p) {
  return String(p || '').replace(/^"+|"+$/g, '').replace(/\//g, '\\').toLowerCase();
}

// ---------- wrapper (CONTRACT section 11) -------------------------------------------------------------

// Escape a JS string for ASCII-only source: backslash, quote, control chars and every non-ASCII UTF-16 unit.
function jsString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (cp >= 0x20 && cp < 0x7f) out += ch;
    else {
      for (let i = 0; i < ch.length; i++) out += '\\u' + ch.charCodeAt(i).toString(16).padStart(4, '0');
    }
  }
  return out + '"';
}

// jsxPath: absolute path of build-ai.jsx (backslashes become forward slashes). args: [jobDir, aiPath, reportPath].
function buildWrapper(jsxPath, args) {
  const evalPath = String(jsxPath).replace(/\\/g, '/');
  return BOM +
    'var __JM_ARGS = [' + args.map(jsString).join(', ') + '];\r\n' +
    '$.evalFile(new File(' + jsString(evalPath) + '));\r\n';
}

// ---------- PowerShell script ----------------------------------------------------------------------------

// PowerShell single-quoted literal. PowerShell also treats the curly single quotes U+2018..U+201B as quotes.
function psq(s) {
  const v = String(s);
  if (/[\u0000-\u001f]/.test(v)) throw new Error('control character in a path');
  return "'" + v.replace(/['\u2018\u2019\u201a\u201b]/g, (c) => c + c) + "'";
}

// opts: { progId, wrapperPath, connectOnly }. Output: UTF-8 text, CRLF, BOM (paths may be non-ASCII).
// Contract with the Node side: stdout = JS result; failures print one line on stderr:
//   JM-ERR stage=<create|invoke|script> hresult=0x........ type=<.NET type> msg=<text>
function buildPs1(opts) {
  const lines = [
    '# Dunk: run an ExtendScript file in Illustrator through COM (Windows PowerShell 5.1)',
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }',
    '$progId = ' + psq(opts.progId || PLAIN_PROGID),
    '$wrapper = ' + psq(opts.wrapperPath || ''),
    '',
    'function Get-JmHresult($ex) {',
    '  $h = 0',
    '  while ($null -ne $ex) {',
    '    if ($ex.HResult -ne 0) { $h = $ex.HResult }',
    '    $ex = $ex.InnerException',
    '  }',
    '  return [int]$h',
    '}',
    'function Write-JmError($stage, $err) {',
    '  $ex = $err.Exception',
    '  $h = Get-JmHresult $ex',
    "  $msg = ([string]$ex.Message) -replace '[\\r\\n]+', ' '",
    "  [Console]::Error.WriteLine(('JM-ERR stage={0} hresult=0x{1:X8} type={2} msg={3}' -f $stage, $h, $ex.GetType().FullName, $msg))",
    '}',
    '',
    'try {',
    '  $ai = $null',
    "  $via = ''",
    '  try {',
    '    $ai = [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)',
    "    $via = 'GetActiveObject'",
    '  } catch {',
    '    $ai = $null',
    '  }',
    '  if ($null -eq $ai) {',
    '    try {',
    '      $ai = New-Object -ComObject $progId',
    "      $via = 'New-Object'",
    '    } catch {',
    "      Write-JmError 'create' $_",
    '      exit 2',
    '    }',
    '  }',
  ];
  if (opts.connectOnly) {
    lines.push(
      "  $ver = ''",
      '  try { $ver = [string]$ai.Version } catch { $ver = ' + "'(Version failed: ' + $_.Exception.Message + ')'" + ' }',
      "  [Console]::Out.WriteLine(('JM-CONNECT via={0} version={1}' -f $via, $ver))",
      '  exit 0'
    );
  } else {
    lines.push(
      '  try {',
      '    $r = $ai.DoJavaScriptFile($wrapper)',
      '  } catch {',
      "    Write-JmError 'invoke' $_",
      '    exit 3',
      '  }',
      "  if ($null -eq $r) { $r = '' }",
      '  [Console]::Out.Write([string]$r)',
      '  exit 0'
    );
  }
  lines.push(
    '} catch {',
    "  Write-JmError 'script' $_",
    '  exit 4',
    '}',
    ''
  );
  return BOM + lines.join('\r\n');
}

// ---------- registry / discovery ---------------------------------------------------------------------------

function defaultRegQuery(args) {
  try {
    return execFileSync(regExePath(), args, { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return ''; // exit 1 = nothing found
  }
}

// `reg query HKCR /f "Illustrator.Application" /k` -> ["Illustrator.Application", "Illustrator.Application.2026", ...]
function parseRegKeys(output) {
  const found = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const m = /^HKEY_CLASSES_ROOT\\([^\\\s]+)\s*$/i.exec(raw.trim());
    if (!m) continue;
    if (!/^Illustrator\.Application(\.[A-Za-z0-9_]+)?$/i.test(m[1])) continue;
    if (found.indexOf(m[1]) === -1) found.push(m[1]);
  }
  return found;
}

// First REG_SZ / REG_EXPAND_SZ data in `reg query ... /ve` output (value name is localised, so ignore it).
function parseRegValue(output) {
  for (const raw of String(output || '').split(/\r?\n/)) {
    const m = /\sREG_(?:EXPAND_)?SZ\s+(.*?)\s*$/.exec(raw);
    if (m) return m[1];
  }
  return null;
}

// LocalServer32 default value, e.g. `"C:\Program Files\...\Illustrator.exe" /Automation` -> exe path.
function parseExeFromCommand(cmd) {
  if (!cmd) return null;
  const m = /^\s*"?([^"]*?\.exe)/i.exec(cmd);
  return m ? m[1] : null;
}

function resolveProgIdExe(progId, reg, depth) {
  depth = depth || 0;
  let clsid = parseRegValue(reg(['query', 'HKCR\\' + progId + '\\CLSID', '/ve']));
  if (!clsid && depth < 2) {
    const cur = parseRegValue(reg(['query', 'HKCR\\' + progId + '\\CurVer', '/ve']));
    if (cur && cur !== progId) return resolveProgIdExe(cur, reg, depth + 1);
  }
  if (!clsid) return null;
  const cmd = parseRegValue(reg(['query', 'HKCR\\CLSID\\' + clsid + '\\LocalServer32', '/ve']));
  return parseExeFromCommand(cmd);
}

function yearFromPath(p) {
  const m = /Illustrator\s+(?:CC\s*)?(\d{4})/i.exec(String(p));
  return m ? parseInt(m[1], 10) : null;
}

// Heuristic only (UNVERIFIED naming): ".2026", ".CC2026" or the internal major version (2026 -> 30).
function progIdMatchesYear(progId, year) {
  const m = /^Illustrator\.Application\.(.+)$/i.exec(progId);
  if (!m || !year) return false;
  const s = m[1].toUpperCase();
  return s === String(year) || s === 'CC' + year || s === String(year - 1996);
}

function pickProgId(exe, year, progIds, exeByProgId) {
  const want = normExe(exe);
  const exact = progIds.filter((p) => exeByProgId[p] && normExe(exeByProgId[p]) === want);
  const exactVersioned = exact.filter((p) => p.toLowerCase() !== PLAIN_PROGID.toLowerCase());
  if (exactVersioned.length) return { progId: exactVersioned[0], how: 'registry-exe' };
  if (exact.length) return { progId: exact[0], how: 'registry-exe' };
  const byYear = progIds.filter((p) => progIdMatchesYear(p, year));
  if (byYear.length) return { progId: byYear[0], how: 'year-guess' };
  return { progId: PLAIN_PROGID, how: progIds.length ? 'plain' : 'plain-unregistered' };
}

// opts: { roots: [ProgramFiles dirs], regQuery(args)->string, illustratorPath: settings override (exe) }
// -> [{year, exe, progId, how, override?}] newest first (override first).
function discover(opts) {
  opts = opts || {};
  const roots = opts.roots || [process.env['ProgramFiles'], process.env['ProgramW6432'], process.env['ProgramFiles(x86)']];
  const reg = opts.regQuery || defaultRegQuery;
  const seen = {};
  const list = [];
  const add = (c) => { const k = normExe(c.exe); if (!seen[k]) { seen[k] = true; list.push(c); } };

  for (const r of roots.filter(Boolean)) {
    const adobe = path.join(r, 'Adobe');
    let names = [];
    try { names = fs.readdirSync(adobe); } catch (e) { continue; }
    for (const n of names) {
      const m = /^Adobe Illustrator (\d{4})$/.exec(n);
      if (!m) continue;
      const year = parseInt(m[1], 10);
      if (year < MIN_YEAR || year > MAX_YEAR) continue;
      const exe = path.join(adobe, n, 'Support Files', 'Contents', 'Windows', 'Illustrator.exe');
      if (fs.existsSync(exe)) add({ year, exe });
    }
  }

  const progIds = parseRegKeys(reg(['query', 'HKCR', '/f', PLAIN_PROGID, '/k']));
  const exeByProgId = {};
  for (const p of progIds) exeByProgId[p] = resolveProgIdExe(p, reg);

  // Installs outside Program Files that the registry knows about.
  for (const p of progIds) {
    const exe = exeByProgId[p];
    const year = exe ? yearFromPath(exe) : null;
    if (exe && year && year >= MIN_YEAR && year <= MAX_YEAR && fs.existsSync(exe)) add({ year, exe });
  }

  const out = list.sort((a, b) => b.year - a.year).map((c) => Object.assign({}, c, pickProgId(c.exe, c.year, progIds, exeByProgId)));

  if (opts.illustratorPath) {
    const exe = String(opts.illustratorPath);
    const year = yearFromPath(exe);
    const known = out.filter((c) => normExe(c.exe) === normExe(exe))[0];
    const cand = known ? Object.assign({}, known) : Object.assign({ year, exe }, pickProgId(exe, year, progIds, exeByProgId));
    cand.override = true;
    return [cand].concat(out.filter((c) => c !== known));
  }
  return out;
}

// Convenience for index.js-style callers: exe path of the first candidate, or null.
function discoverExe(opts) {
  const c = discover(opts);
  return c.length ? c[0].exe : null;
}

// ---------- error mapping --------------------------------------------------------------------------------------

// HRESULT -> { code, detail }. All UNVERIFIED on a real machine unless noted in the header.
const HRESULTS = {
  '0x800401F3': ['COM_UNAVAILABLE', 'Illustrator is not registered for COM (invalid class string / ProgID).'],
  '0x80040154': ['COM_UNAVAILABLE', 'Illustrator COM class is not registered.'],
  '0x8002801D': ['COM_UNAVAILABLE', 'Illustrator type library is not registered (try repairing the install or starting Illustrator once).'],
  '0x80080005': ['COM_UNAVAILABLE', 'Illustrator could not be started by COM (licence or sign-in dialog? open it manually once).'],
  '0x80070005': ['COM_UNAVAILABLE', 'Access denied: Illustrator probably runs as administrator or as another user.'],
  '0x80010001': ['ILLUSTRATOR_BUSY', 'Illustrator rejected the call (RPC_E_CALL_REJECTED): busy or a dialog is open.'],
  '0x8001010A': ['ILLUSTRATOR_BUSY', 'Illustrator is busy (RPC_E_SERVERCALL_RETRYLATER): close open dialogs.'],
  '0x800706BA': ['JSX_FAILED', 'The connection to Illustrator was lost (RPC server unavailable): did it crash or quit?'],
  '0x800706BE': ['JSX_FAILED', 'The connection to Illustrator failed during the call (RPC call failed).'],
  '0x80010108': ['JSX_FAILED', 'Illustrator disconnected during the job (crashed or closed).'],
  '0x80010105': ['JSX_FAILED', 'Illustrator threw an exception during the call.'],
  '0x80020009': ['JSX_FAILED', 'Illustrator reported an error while running the script.'],
};

const PS_BLOCKED_RE = /running scripts is disabled|PSSecurityException|ExecutionPolicy|ConstrainedLanguage|language mode|blocked by group policy|is not recognized as the name of a cmdlet|AppLocker/i;

function firstLine(s, n) {
  const t = String(s || '').replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean)[0] || '';
  return t.length > (n || 240) ? t.slice(0, n || 240) + '...' : t;
}

// info: { spawnCode, killed, stderr, stdout, exitCode } -> { code, detail, hresult? }
function mapFailure(info) {
  const stderr = String(info.stderr || '');
  if (info.killed) return { code: 'TIMEOUT', detail: 'Illustrator did not finish in time.' };
  if (info.spawnCode && /^(ENOENT|EACCES|EPERM|UNKNOWN)$/.test(String(info.spawnCode))) {
    return { code: 'POWERSHELL_BLOCKED', detail: 'PowerShell could not be started (' + info.spawnCode + ').' };
  }
  let hr = null;
  const jm = /JM-ERR stage=(\w+) hresult=(0x[0-9A-Fa-f]{8})/.exec(stderr);
  if (jm) hr = jm[2];
  else {
    const m = /HRESULT:?\s*(0x[0-9A-Fa-f]{8})/i.exec(stderr) || /(0x8[0-9A-Fa-f]{7})/.exec(stderr);
    if (m) hr = m[1];
  }
  if (hr) {
    hr = '0x' + hr.slice(2).toUpperCase();
    if (HRESULTS[hr]) return { code: HRESULTS[hr][0], detail: HRESULTS[hr][1] + ' [' + hr + ']', hresult: hr };
  }
  if (PS_BLOCKED_RE.test(stderr)) return { code: 'POWERSHELL_BLOCKED', detail: 'PowerShell is restricted on this PC. ' + firstLine(stderr), hresult: hr || undefined };
  if (/Invalid class string|Class not registered|Retrieving the COM class factory/i.test(stderr)) {
    return { code: 'COM_UNAVAILABLE', detail: 'Illustrator COM class is not registered. ' + firstLine(stderr) };
  }
  const msg = /msg=(.*)$/m.exec(stderr);
  const exit = info.exitCode != null ? ' (exit ' + info.exitCode + ')' : '';
  return { code: 'JSX_FAILED', detail: (msg ? msg[1].trim() : firstLine(stderr) || 'PowerShell failed') + exit + (hr ? ' [' + hr + ']' : ''), hresult: hr || undefined };
}

function makeError(code, detail, extra) {
  const e = new Error(detail);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ---------- run ----------------------------------------------------------------------------------------------------

function readResultFile(jobDir) {
  try {
    const t = fs.readFileSync(path.join(jobDir, 'result.txt'), 'utf8').replace(/^\uFEFF/, '').trim();
    return t || null;
  } catch (e) { return null; }
}

function execPs(ps1, opts) {
  const run = opts.execFile || execFile;
  const timeout = opts.timeoutMs || 11 * 60 * 1000;
  return new Promise((resolve) => {
    const child = run(opts.powershell || powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').replace(/^\uFEFF/, ''),
          stderr: String(stderr || '').replace(/^\uFEFF/, ''),
          exitCode: err && typeof err.code === 'number' ? err.code : (err ? null : 0),
          spawnCode: err && typeof err.code === 'string' ? err.code : null,
          killed: !!(err && err.killed),
        });
      });
    try { if (child && child.stdin) child.stdin.end(); } catch (e) { /* ignore */ }
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function resolveProgId(appPath, opts) {
  if (opts.progId) return opts.progId;
  const c = discover(Object.assign({}, opts.discover, { illustratorPath: appPath }))[0];
  return (c && c.progId) || PLAIN_PROGID;
}

// Detailed variant (used by probe). Resolves { result, source, stdout, stderr, attempts, progId }.
async function runJsxDetailed(appPath, jsxPath, args, opts) {
  opts = opts || {};
  if (appPath && typeof appPath === 'object') appPath = appPath.exe;
  if (!appPath || !fs.existsSync(appPath)) {
    throw makeError('ILLUSTRATOR_NOT_FOUND', 'Illustrator.exe not found' + (appPath ? ': ' + appPath : '') + '.');
  }
  const jobDir = args[0];
  fs.mkdirSync(jobDir, { recursive: true });
  const progId = resolveProgId(appPath, opts);
  const wrapperPath = path.join(jobDir, 'run.jsx');
  const ps1Path = path.join(jobDir, 'run.ps1');
  fs.writeFileSync(wrapperPath, buildWrapper(path.resolve(jsxPath), args), 'utf8');
  fs.writeFileSync(ps1Path, buildPs1({ progId, wrapperPath }), 'utf8');

  const retries = opts.busyRetries != null ? opts.busyRetries : BUSY_RETRIES;
  const backoff = opts.busyBackoffMs != null ? opts.busyBackoffMs : BUSY_BACKOFF_MS;
  const wait = opts.sleep || sleep;

  for (let attempt = 1; ; attempt++) {
    try { fs.unlinkSync(path.join(jobDir, 'result.txt')); } catch (e) { /* none */ }
    const r = await execPs(ps1Path, opts);
    const fromFile = readResultFile(jobDir);
    if (r.ok) {
      const out = fromFile != null ? fromFile : r.stdout.trim();
      if (!out) throw makeError('JSX_FAILED', 'Illustrator returned no result (no result.txt, empty output).', { stderr: r.stderr, attempts: attempt, progId });
      return { result: out, source: fromFile != null ? 'result.txt' : 'stdout', stdout: r.stdout, stderr: r.stderr, attempts: attempt, progId };
    }
    // The JSX may have finished although the COM call failed afterwards: trust its own result file.
    if (fromFile != null && !r.killed) {
      return { result: fromFile, source: 'result.txt', stdout: r.stdout, stderr: r.stderr, attempts: attempt, progId };
    }
    const m = mapFailure(r);
    if (m.code === 'ILLUSTRATOR_BUSY' && attempt <= retries) { await wait(backoff); continue; }
    throw makeError(m.code, m.detail, { stderr: r.stderr, stdout: r.stdout, hresult: m.hresult, attempts: attempt, progId });
  }
}

// opts: { timeoutMs, progId, discover, execFile, sleep, busyRetries, busyBackoffMs } (last four for tests)
async function runJsx(appPath, jsxPath, args, opts) {
  return (await runJsxDetailed(appPath, jsxPath, args, opts)).result;
}

// ---------- probe ---------------------------------------------------------------------------------------------

const PROBE_VERSION_JSX =
  'var d = (typeof __JM_ARGS !== "undefined") ? __JM_ARGS[0] : "";\r\n' +
  'var out = "OK|" + app.version;\r\n' +
  '(function () { try { var f = new File(d.replace(/\\\\/g, "/") + "/result.txt"); f.encoding = "UTF-8"; f.open("w"); f.write(out); f.close(); } catch (e) {} })();\r\n' +
  'out;\r\n';

const PROBE_UNICODE_JSX =
  'var d = __JM_ARGS[0].replace(/\\\\/g, "/");\r\n' +
  'var f = new File(d + "/jsx-wrote-\\u00e1\\u0171.txt");\r\n' +
  'f.encoding = "UTF-8"; f.open("w"); f.write("\\u00c1rv\\u00edzt\\u0171r\\u0151 \\u2713"); f.close();\r\n' +
  'var out = "OK|" + f.exists + "|" + Folder(d).fsName;\r\n' +
  'var r = new File(d + "/result.txt"); r.encoding = "UTF-8"; r.open("w"); r.write(out); r.close();\r\n' +
  'out;\r\n';

// opts: { illustratorPath, discover (discover opts), ...runJsx opts } -> Promise<string> (plain text report)
async function probe(opts) {
  opts = opts || {};
  const lines = [];
  let failed = 0;
  const say = (s) => lines.push(s);
  const ok = (name, d) => say('[ OK ] ' + name + (d ? ': ' + d : ''));
  const bad = (name, d) => { failed++; say('[FAIL] ' + name + (d ? ': ' + d : '')); };
  const errText = (e) => (e.code ? e.code + ': ' : '') + e.message + (e.stderr ? '\n         stderr: ' + String(e.stderr).trim().replace(/\n/g, '\n                 ').slice(0, 2000) : '');

  say('Dunk Windows probe ' + new Date().toISOString());
  say('OS: ' + os.type() + ' ' + os.release() + ' ' + os.arch() + ', node ' + process.version);
  const ps = opts.powershell || powershellPath();
  if (fs.existsSync(ps)) ok('PowerShell', ps); else bad('PowerShell', 'not found at ' + ps);

  // 1. discovery
  let cands = [];
  try {
    cands = discover(Object.assign({}, opts.discover, { illustratorPath: opts.illustratorPath }));
    if (!cands.length) bad('Discovery', 'no Illustrator 2024-2026 found (set the Illustrator path in the menu)');
    else {
      ok('Discovery', cands.length + ' candidate(s)');
      cands.forEach((c, i) => say('       ' + (i === 0 ? '> ' : '  ') + (c.year || '?') + '  ' + c.exe + '  progId=' + c.progId + ' (' + c.how + ')' + (c.override ? ' [settings override]' : '')));
    }
  } catch (e) { bad('Discovery', errText(e)); }

  // 2. ProgID lookup (raw)
  try {
    const reg = (opts.discover && opts.discover.regQuery) || defaultRegQuery;
    const ids = parseRegKeys(reg(['query', 'HKCR', '/f', PLAIN_PROGID, '/k']));
    if (ids.length) ok('ProgID lookup', ids.join(', ')); else bad('ProgID lookup', 'no Illustrator.Application* key in HKEY_CLASSES_ROOT (COM not registered)');
  } catch (e) { bad('ProgID lookup', errText(e)); }

  const cand = cands[0];
  if (!cand) {
    say('Remaining steps skipped: no Illustrator candidate.');
  } else {
    const base = path.join(fs.realpathSync.native ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir(), 'jm-probe-' + Date.now());
    const ropts = Object.assign({}, opts, { progId: cand.progId, timeoutMs: opts.timeoutMs || 3 * 60 * 1000 });
    const jsxDir = path.join(base, 'jsx');
    fs.mkdirSync(jsxDir, { recursive: true });

    // 3. COM connect only
    try {
      const dir = path.join(base, 'connect');
      fs.mkdirSync(dir, { recursive: true });
      const ps1 = path.join(dir, 'connect.ps1');
      fs.writeFileSync(ps1, buildPs1({ progId: cand.progId, connectOnly: true }), 'utf8');
      const r = await execPs(ps1, ropts);
      if (r.ok) ok('COM connect', r.stdout.trim());
      else { const m = mapFailure(r); bad('COM connect', m.code + ': ' + m.detail + '\n         stderr: ' + r.stderr.trim().slice(0, 2000)); }
    } catch (e) { bad('COM connect', errText(e)); }

    // 4. app.version through the wrapper
    try {
      const jsx = path.join(jsxDir, 'probe-version.jsx');
      fs.writeFileSync(jsx, PROBE_VERSION_JSX, 'utf8');
      const d = await runJsxDetailed(cand.exe, jsx, [path.join(base, 'version'), 'x', 'y'], ropts);
      ok('Wrapper + app.version', d.result + ' (via ' + d.source + ', attempts ' + d.attempts + ')');
    } catch (e) { bad('Wrapper + app.version', errText(e)); }

    // 5. Unicode path round trip
    try {
      const jsx = path.join(jsxDir, 'probe-unicode.jsx');
      fs.writeFileSync(jsx, PROBE_UNICODE_JSX, 'utf8');
      const dir = path.join(base, '\u00c1rv\u00edzt\u0171r\u0151');
      const d = await runJsxDetailed(cand.exe, jsx, [dir, 'x', 'y'], ropts);
      const want = '\u00c1rv\u00edzt\u0171r\u0151 \u2713';
      let got = null;
      try { got = fs.readFileSync(path.join(dir, 'jsx-wrote-\u00e1\u0171.txt'), 'utf8').replace(/^\uFEFF/, ''); } catch (e) { /* missing */ }
      if (got === want) ok('Unicode path round trip', d.result);
      else bad('Unicode path round trip', 'JSX said "' + d.result + '" but the file written by Illustrator was ' + (got === null ? 'not found in ' + dir : 'different: ' + JSON.stringify(got)));
    } catch (e) { bad('Unicode path round trip', errText(e)); }

    say('Probe files: ' + base);
  }

  say('');
  say(failed ? 'RESULT: ' + failed + ' step(s) FAILED' : 'RESULT: all steps OK');
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  discover, discoverExe, runJsx, runJsxDetailed, probe, buildWrapper, buildPs1,
  // exposed for tests
  parseRegKeys, parseRegValue, parseExeFromCommand, mapFailure, jsString, psq, powershellPath,
};
