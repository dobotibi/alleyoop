'use strict';
// Run from the project root: node tests/win/win-adapter.test.js   (no dependencies, runs on macOS too)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const win = require('../../dunk/src/illustrator/win.js');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) { pending.push({ name, fn }); }

// ---- wrapper ------------------------------------------------------------------------------------
function evalWrapper(text) {
  const evaluated = [];
  const ctx = { $: { evalFile: (f) => { evaluated.push(f.path); return 'OK'; } }, File: function (p) { this.path = p; } };
  const result = vm.runInNewContext(text.replace(/^\uFEFF/, ''), ctx);
  return { args: ctx.__JM_ARGS, evaluated, result };
}

test('wrapper: BOM, ASCII-only body, round-trips tricky strings', () => {
  const args = ['C:\\Users\\T\u00f3th \u00c1rp\u00e1d\\Temp\\job "1"', 'D:\\\u00c1rv\u00edzt\u0171r\u0151\\out.ai', 'a\u2028b\u2029c \ud83d\ude00 \u0151\u0171'];
  const jsx = 'C:\\Program Files\\Json MAClane\\resources\\build-ai.jsx';
  const w = win.buildWrapper(jsx, args);
  assert.strictEqual(w.charCodeAt(0), 0xFEFF);
  assert.ok(/^[\x00-\x7f]*$/.test(w.slice(1)), 'body must be pure ASCII');
  assert.ok(!/\u2028|\u2029/.test(w));
  assert.ok(w.includes('\\u2028') && w.includes('\\u0151'));
  const r = evalWrapper(w);
  assert.deepStrictEqual(Array.from(r.args), args);
  assert.deepStrictEqual(r.evaluated, ['C:/Program Files/Json MAClane/resources/build-ai.jsx']);
  assert.strictEqual(r.result, 'OK');
});

test('wrapper: quotes and backslash escaping in source', () => {
  const w = win.buildWrapper('C:\\x\\b.jsx', ['a"b', 'c\\d', 'e']);
  assert.ok(w.includes('"a\\"b"'));
  assert.ok(w.includes('"c\\\\d"'));
  assert.ok(w.includes('new File("C:/x/b.jsx")'));
});

test('wrapper: Hungarian accents', () => {
  const s = '\u00e1\u00e9\u00ed\u00f3\u00f6\u0151\u00fa\u00fc\u0171\u00c1\u00c9\u00cd\u00d3\u00d6\u0150\u00da\u00dc\u0170';
  const w = win.buildWrapper('/a.jsx', [s, 'b', 'c']);
  assert.deepStrictEqual(Array.from(evalWrapper(w).args)[0], s);
});

// ---- ps1 ------------------------------------------------------------------------------------------------
test('ps1: required content', () => {
  const p = win.buildPs1({ progId: 'Illustrator.Application.2026', wrapperPath: 'C:\\Temp\\job\\run.jsx' });
  assert.strictEqual(p.charCodeAt(0), 0xFEFF);
  assert.ok(p.includes('GetActiveObject($progId)'));
  assert.ok(p.includes('New-Object -ComObject $progId'));
  assert.ok(p.indexOf('GetActiveObject') < p.indexOf('New-Object -ComObject'));
  assert.ok(p.includes("$progId = 'Illustrator.Application.2026'"));
  assert.ok(p.includes("$wrapper = 'C:\\Temp\\job\\run.jsx'"));
  assert.ok(p.includes('$ai.DoJavaScriptFile($wrapper)'));
  assert.ok(p.includes('OutputEncoding = New-Object System.Text.UTF8Encoding($false)'));
  assert.ok(p.includes('JM-ERR'));
  assert.ok(!p.includes('??'), 'no PS7 null-coalescing');
  assert.ok(!/\bpwsh\b/.test(p));
  assert.ok(/\r\n/.test(p) && !/[^\r]\n/.test(p), 'CRLF only');
});

test('ps1: quote escaping (apostrophes, curly quotes)', () => {
  const p = win.buildPs1({ progId: 'Illustrator.Application', wrapperPath: "C:\\O'Neil\\\u2018x\u2019\\run.jsx" });
  assert.ok(p.includes("C:\\O''Neil\\\u2018\u2018x\u2019\u2019\\run.jsx"));
  assert.throws(() => win.buildPs1({ progId: 'x', wrapperPath: 'a\nb' }));
});

test('ps1: balanced braces/parens (cheap syntax sanity)', () => {
  for (const connectOnly of [false, true]) {
    const p = win.buildPs1({ progId: 'Illustrator.Application', wrapperPath: 'C:\\a\\run.jsx', connectOnly });
    const strip = p.replace(/'(?:[^']|'')*'/g, "''"); // drop string literals
    const count = (c) => strip.split(c).length - 1;
    assert.strictEqual(count('{'), count('}'));
    assert.strictEqual(count('('), count(')'));
    if (connectOnly) { assert.ok(!p.includes('DoJavaScriptFile($wrapper)')); assert.ok(p.includes('JM-CONNECT')); }
  }
});

// ---- reg output parsing ---------------------------------------------------------------------------------------
const REG_VERSIONED =
  '\r\nHKEY_CLASSES_ROOT\\Illustrator.Application\r\nHKEY_CLASSES_ROOT\\Illustrator.Application.2025\r\nHKEY_CLASSES_ROOT\\Illustrator.Application.2026\r\n\r\nEnd of search: 3 match(es) found.\r\n';
const REG_PLAIN = '\r\nHKEY_CLASSES_ROOT\\Illustrator.Application\r\n\r\nEnd of search: 1 match(es) found.\r\n';
const REG_NONE = '\r\nEnd of search: 0 match(es) found.\r\n';
const REG_HU = '\r\nHKEY_CLASSES_ROOT\\Illustrator.Application\r\nHKEY_CLASSES_ROOT\\Illustrator.ApplicationHelper\r\nHKEY_CLASSES_ROOT\\Illustrator.Application.CC2019\\CLSID\r\n\r\nA keres\u00e9s v\u00e9ge: 1 tal\u00e1lat.\r\n';

test('reg parse: versioned, plain, none, localised noise', () => {
  assert.deepStrictEqual(win.parseRegKeys(REG_VERSIONED), ['Illustrator.Application', 'Illustrator.Application.2025', 'Illustrator.Application.2026']);
  assert.deepStrictEqual(win.parseRegKeys(REG_PLAIN), ['Illustrator.Application']);
  assert.deepStrictEqual(win.parseRegKeys(REG_NONE), []);
  assert.deepStrictEqual(win.parseRegKeys(''), []);
  assert.deepStrictEqual(win.parseRegKeys(undefined), []);
  assert.deepStrictEqual(win.parseRegKeys(REG_HU), ['Illustrator.Application']);
});

test('reg parse: value + exe from LocalServer32', () => {
  const out = '\r\nHKEY_CLASSES_ROOT\\CLSID\\{AAA}\\LocalServer32\r\n    (alap\u00e9rtelmezett)    REG_SZ    "C:\\Program Files\\Adobe\\Adobe Illustrator 2026\\Support Files\\Contents\\Windows\\Illustrator.exe" /Automation\r\n';
  const v = win.parseRegValue(out);
  assert.strictEqual(win.parseExeFromCommand(v), 'C:\\Program Files\\Adobe\\Adobe Illustrator 2026\\Support Files\\Contents\\Windows\\Illustrator.exe');
  assert.strictEqual(win.parseExeFromCommand('C:\\x\\Illustrator.exe'), 'C:\\x\\Illustrator.exe');
  assert.strictEqual(win.parseRegValue(''), null);
});

// ---- discovery with a fake root ---------------------------------------------------------------------------------
function fakeTree(years, extra) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-win-test-'));
  for (const y of years) {
    const d = path.join(root, 'Adobe', 'Adobe Illustrator ' + y, 'Support Files', 'Contents', 'Windows');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'Illustrator.exe'), '');
  }
  for (const n of extra || []) fs.mkdirSync(path.join(root, 'Adobe', n), { recursive: true });
  return root;
}
function fakeReg(table) { // table: { 'key substring': output }
  return (args) => {
    const key = args.join(' ');
    for (const k of Object.keys(table)) if (key.indexOf(k) !== -1) return table[k];
    return '';
  };
}
const exeOf = (root, y) => path.join(root, 'Adobe', 'Adobe Illustrator ' + y, 'Support Files', 'Contents', 'Windows', 'Illustrator.exe');
const regVal = (v) => '\r\nHKEY\\x\r\n    (Default)    REG_SZ    ' + v + '\r\n';

test('discovery: years 2024-2026 only, newest first, exe-matched versioned ProgIDs', () => {
  const root = fakeTree([2023, 2024, 2026], ['Adobe Illustrator 2026 (Beta)', 'Adobe Illustrator CC 2019', 'Adobe Photoshop 2026']);
  const reg = fakeReg({
    '/f Illustrator.Application /k': REG_VERSIONED,
    'Illustrator.Application.2026\\CLSID': regVal('{C26}'),
    'Illustrator.Application.2025\\CLSID': regVal('{C25}'),
    'Illustrator.Application\\CLSID': regVal('{C26}'),
    'CLSID\\{C26}\\LocalServer32': regVal('"' + exeOf(root, 2026) + '" /Automation'),
    'CLSID\\{C25}\\LocalServer32': regVal('"' + exeOf(root, 2025) + '"'),
  });
  const c = win.discover({ roots: [root], regQuery: reg });
  assert.deepStrictEqual(c.map((x) => x.year), [2026, 2024]);
  assert.strictEqual(c[0].exe, exeOf(root, 2026));
  assert.strictEqual(c[0].progId, 'Illustrator.Application.2026'); // versioned beats plain although both map to the same exe
  assert.strictEqual(c[0].how, 'registry-exe');
  assert.strictEqual(c[1].progId, 'Illustrator.Application'); // 2024 has no versioned id: plain
});

test('discovery: only plain ProgID, and no registry at all', () => {
  const root = fakeTree([2025]);
  let c = win.discover({ roots: [root], regQuery: fakeReg({ '/f Illustrator.Application /k': REG_PLAIN }) });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].progId, 'Illustrator.Application');
  c = win.discover({ roots: [root], regQuery: fakeReg({ '/f Illustrator.Application /k': REG_NONE }) });
  assert.strictEqual(c[0].progId, 'Illustrator.Application');
  assert.strictEqual(c[0].how, 'plain-unregistered');
});

test('discovery: year-guess ProgID, none installed, settings override', () => {
  const root = fakeTree([2026, 2025]);
  const reg = fakeReg({ '/f Illustrator.Application /k': REG_VERSIONED });
  let c = win.discover({ roots: [root], regQuery: reg });
  assert.strictEqual(c[0].progId, 'Illustrator.Application.2026');
  assert.strictEqual(c[0].how, 'year-guess');
  const ov = win.discover({ roots: [root], regQuery: reg, illustratorPath: exeOf(root, 2025) });
  assert.strictEqual(ov[0].exe, exeOf(root, 2025));
  assert.strictEqual(ov[0].override, true);
  assert.strictEqual(ov.length, 2);
  const ov2 = win.discover({ roots: [root], regQuery: reg, illustratorPath: 'D:\\Apps\\Illustrator 2026\\Illustrator.exe' });
  assert.strictEqual(ov2[0].override, true);
  assert.strictEqual(ov2.length, 3);
  assert.deepStrictEqual(win.discover({ roots: [fs.mkdtempSync(path.join(os.tmpdir(), 'jm-empty-'))], regQuery: fakeReg({}) }), []);
  assert.strictEqual(win.discoverExe({ roots: [root], regQuery: reg }), exeOf(root, 2026));
});

// ---- HRESULT mapping -------------------------------------------------------------------------------------------
const jmErr = (h, msg) => 'JM-ERR stage=invoke hresult=' + h + ' type=System.Runtime.InteropServices.COMException msg=' + (msg || 'x');
test('HRESULT mapping', () => {
  const m = (stderr, extra) => win.mapFailure(Object.assign({ stderr }, extra));
  assert.strictEqual(m(jmErr('0x80010001')).code, 'ILLUSTRATOR_BUSY');
  assert.strictEqual(m(jmErr('0x8001010a')).code, 'ILLUSTRATOR_BUSY');
  assert.strictEqual(m(jmErr('0x800401F3')).code, 'COM_UNAVAILABLE');
  assert.strictEqual(m(jmErr('0x80040154')).code, 'COM_UNAVAILABLE');
  assert.strictEqual(m(jmErr('0x80080005')).code, 'COM_UNAVAILABLE');
  assert.strictEqual(m(jmErr('0x80070005')).code, 'COM_UNAVAILABLE');
  assert.strictEqual(m(jmErr('0x800706BA')).code, 'JSX_FAILED');
  assert.strictEqual(m(jmErr('0x80020009')).code, 'JSX_FAILED');
  assert.strictEqual(m('Exception calling "DoJavaScriptFile": (Exception from HRESULT: 0x80010001 (RPC_E_CALL_REJECTED))').code, 'ILLUSTRATOR_BUSY');
  assert.strictEqual(m('Retrieving the COM class factory for component with CLSID {} failed').code, 'COM_UNAVAILABLE');
  assert.strictEqual(m('File x.ps1 cannot be loaded because running scripts is disabled on this system.').code, 'POWERSHELL_BLOCKED');
  assert.strictEqual(m('', { spawnCode: 'ENOENT' }).code, 'POWERSHELL_BLOCKED');
  assert.strictEqual(m('', { killed: true }).code, 'TIMEOUT');
  const u = m(jmErr('0x80131501', 'weird'), { exitCode: 3 });
  assert.strictEqual(u.code, 'JSX_FAILED');
  assert.ok(u.detail.includes('weird'));
  assert.ok(m(jmErr('0x80010001')).detail.length < 200);
});

// ---- runJsx with a fake powershell -------------------------------------------------------------------------------
function fakeRun(behaviours, seen) {
  let i = 0;
  return (file, args, o, cb) => {
    const b = behaviours[Math.min(i++, behaviours.length - 1)];
    seen.push({ file, args });
    b(args, cb);
    return { stdin: { end() {} } };
  };
}
function job() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-job-\u00c1-'));
  const exe = path.join(dir, 'Illustrator.exe'); fs.writeFileSync(exe, '');
  return { dir, exe, jsx: path.join(dir, 'build-ai.jsx') };
}
const okRun = (out) => (a, cb) => cb(null, out, '');
const failRun = (stderr, code) => (a, cb) => { const e = new Error('Command failed'); e.code = code == null ? 1 : code; cb(e, '', stderr); };

test('runJsx: writes wrapper+ps1, uses absolute powershell and flags, returns stdout', async () => {
  const j = job(); const seen = [];
  const r = await win.runJsx(j.exe, j.jsx, [j.dir, 'x.ai', 'r.json'], { progId: 'Illustrator.Application', execFile: fakeRun([okRun('OK\r\n')], seen) });
  assert.strictEqual(r, 'OK');
  assert.ok(/powershell\.exe$/i.test(seen[0].file) && /System32/i.test(seen[0].file));
  assert.deepStrictEqual(seen[0].args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.strictEqual(seen[0].args[5], path.join(j.dir, 'run.ps1'));
  assert.ok(fs.readFileSync(path.join(j.dir, 'run.jsx'), 'utf8').startsWith('\uFEFFvar __JM_ARGS'));
  assert.ok(fs.readFileSync(path.join(j.dir, 'run.ps1'), 'utf8').includes('DoJavaScriptFile($wrapper)'));
});

test('runJsx: prefers result.txt', async () => {
  const j = job();
  const run = (a, cb) => { fs.writeFileSync(path.join(j.dir, 'result.txt'), '\uFEFFERR:boom \u0151\n'); cb(null, 'OK', ''); };
  const r = await win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([run], []) });
  assert.strictEqual(r, 'ERR:boom \u0151');
});

test('runJsx: retries BUSY 3x then fails; succeeds when busy clears', async () => {
  const j = job(); const seen = []; const waits = [];
  const busy = failRun(jmErr('0x80010001'), 3);
  await assert.rejects(
    win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([busy], seen), sleep: (ms) => { waits.push(ms); return Promise.resolve(); } }),
    (e) => e.code === 'ILLUSTRATOR_BUSY' && e.attempts === 4 && /RPC_E_CALL_REJECTED/.test(e.message) && /JM-ERR/.test(e.stderr));
  assert.strictEqual(seen.length, 4);
  assert.deepStrictEqual(waits, [5000, 5000, 5000]);
  const seen2 = [];
  const r = await win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([busy, busy, okRun('OK')], seen2), sleep: () => Promise.resolve() });
  assert.strictEqual(r, 'OK'); assert.strictEqual(seen2.length, 3);
});

test('runJsx: error codes (not found, timeout, blocked, empty result)', async () => {
  const j = job();
  await assert.rejects(win.runJsx(path.join(j.dir, 'nope.exe'), j.jsx, [j.dir, 'x', 'y'], { progId: 'P' }), (e) => e.code === 'ILLUSTRATOR_NOT_FOUND');
  const killed = (a, cb) => { const e = new Error('t'); e.killed = true; cb(e, '', ''); };
  await assert.rejects(win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([killed], []) }), (e) => e.code === 'TIMEOUT');
  const enoent = (a, cb) => { const e = new Error('spawn'); e.code = 'ENOENT'; cb(e, '', ''); };
  await assert.rejects(win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([enoent], []) }), (e) => e.code === 'POWERSHELL_BLOCKED');
  await assert.rejects(win.runJsx(j.exe, j.jsx, [j.dir, 'x', 'y'], { progId: 'P', execFile: fakeRun([okRun('')], []) }), (e) => e.code === 'JSX_FAILED');
});

test('probe: returns a text report (fake PowerShell, fake registry)', async () => {
  const root = fakeTree([2026]);
  const run = (file, args, o, cb) => {
    const ps1 = fs.readFileSync(args[5], 'utf8');
    if (ps1.includes('JM-CONNECT')) return cb(null, 'JM-CONNECT via=New-Object version=30.0\r\n', ''), { stdin: { end() {} } };
    cb(null, 'OK|30.0', ''); return { stdin: { end() {} } };
  };
  const report = await win.probe({ discover: { roots: [root], regQuery: fakeReg({ '/f Illustrator.Application /k': REG_PLAIN }) }, execFile: run });
  assert.strictEqual(typeof report, 'string');
  for (const s of ['Discovery', 'ProgID lookup', 'COM connect', 'Wrapper + app.version', 'Unicode path round trip']) assert.ok(report.includes(s), s);
  assert.ok(/\[ OK \] COM connect: JM-CONNECT via=New-Object version=30\.0/.test(report));
  assert.ok(/\[FAIL\] Unicode path round trip/.test(report), 'fake JSX writes no file, so this must fail loudly');
});

(async () => {
  for (const t of pending) {
    try { await t.fn(); passed++; console.log('ok   - ' + t.name); }
    catch (e) { failed++; console.log('FAIL - ' + t.name + '\n       ' + (e && e.stack || e)); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
