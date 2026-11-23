// Run: node tests/naming.test.js  (no dependencies)
const assert = require('assert');
const path = require('path');

// minimal Figma stub so code.js can be loaded outside Figma
global.__html__ = '';
global.figma = {
  mixed: Symbol('mixed'),
  showUI() {},
  ui: { postMessage() {}, onmessage: null },
  on() {},
  clientStorage: { getAsync: () => Promise.resolve(undefined), setAsync: () => Promise.resolve() },
  currentPage: { selection: [] }
};
const N = require(path.join(__dirname, '..', 'figma-plugin', 'code.js'));

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('ok  ' + name); }

const txt = (chars, name) => ({ type: 'TEXT', name: name === undefined ? chars : name, characters: chars, visible: true });
const rect = (name, fills) => ({ type: 'RECTANGLE', name, fills: fills || [], visible: true });
const group = (name, children, type) => ({ type: type || 'GROUP', name, children, visible: true, fills: [] });
const base = (n, lang, plus) => N.baseNameFor(n, lang || 'hu', plus);
const full = (o) => N.composeLayerName(Object.assign({ ctx: [], lang: 'hu' }, o));

t('regular name is kept (whitespace collapsed)', () => {
  assert.strictEqual(base(rect('  Logo   mark ')).name, 'Logo mark');
  assert.strictEqual(base(rect('Logo')).replaced, false);
});
t('auto rectangle -> Teglalap / Rectangle', () => {
  assert.strictEqual(base(rect('Rectangle 12')).name, 'Teglalap');
  assert.strictEqual(base(rect('rectangle 3'), 'en').name, 'Rectangle');
  assert.strictEqual(base(rect('Rectangle 12')).from, 'Rectangle 12');
});
t('auto type words (hu)', () => {
  const m = { Ellipse: 'ELLIPSE', Vector: 'VECTOR', Line: 'LINE', Polygon: 'POLYGON', Star: 'STAR', Union: 'BOOLEAN_OPERATION', Component: 'COMPONENT', Instance: 'INSTANCE', Frame: 'FRAME' };
  const hu = { ELLIPSE: 'Ellipszis', VECTOR: 'Vektor', LINE: 'Vonal', POLYGON: 'Sokszog', STAR: 'Csillag', BOOLEAN_OPERATION: 'Alakzat', COMPONENT: 'Komponens', INSTANCE: 'Peldany', FRAME: 'Keret' };
  Object.keys(m).forEach(k => assert.strictEqual(base({ type: m[k], name: k + ' 4', visible: true }).name, hu[m[k]]));
});
t('auto TEXT name -> its characters', () => {
  assert.strictEqual(base(txt('Hello world', 'Frame 7')).name, 'Hello world');
});
t('text content: first line only, collapsed', () => {
  assert.strictEqual(base(txt('Első sor\nMásodik', 'Group 1')).name, 'Elso sor');
  assert.strictEqual(base(txt('\n  Üres   eleje', 'Vector')).name, 'Ures eleje');
});
t('text content truncated to 32 chars + ellipsis', () => {
  const long = 'A'.repeat(40);
  assert.strictEqual(base(txt(long, 'Group 2')).name, 'A'.repeat(32) + '...');
});
t('image fill -> Kép / Image', () => {
  const r = rect('Rectangle 5', [{ type: 'IMAGE', visible: true }]);
  assert.strictEqual(base(r).name, 'Kep');
  assert.strictEqual(base(r, 'en').name, 'Image');
  assert.strictEqual(base(group('Group 9', [r])).name, 'Kep');
  // image + caption: text wins
  const cap = group('Frame 5', [rect('Rectangle 1', [{ type: 'IMAGE', visible: true }]), txt('Caption')]);
  assert.strictEqual(base(cap).name, 'Csoport: Caption');
  assert.strictEqual(base(cap, 'en').name, 'Group: Caption');
});
t('container with text -> "Csoport: <text max 24>"', () => {
  const g = group('Group 3', [rect('Rectangle 1'), txt('Vasarolj most a boltban ma!')]);
  assert.strictEqual(base(g).name, 'Csoport: Vasarolj most a boltban' .slice(0, 9 + 24).replace(/\s+$/, '') + '...');
  assert.strictEqual(base(group('Frame 2', [txt('Hi')]), 'en').name, 'Group: Hi');
});
t('hidden text is ignored for the group label', () => {
  const hidden = txt('secret'); hidden.visible = false;
  assert.strictEqual(base(group('Group 1', [hidden, rect('Rectangle 2')])).name, 'Csoport');
});
t('plus prefix stripped; explode context path', () => {
  assert.strictEqual(base(group('+Card', []), 'hu', true).name, 'Card');
  assert.strictEqual(full({ ctx: ['Card'], base: 'Title', role: 'vector' }), 'Card / Title');
  assert.strictEqual(full({ ctx: ['Card', 'Inner'], base: 'Title', role: 'vector' }), 'Card / Inner / Title');
});
t('role suffixes hu/en', () => {
  assert.strictEqual(full({ role: 'background' }), 'Hatter');
  assert.strictEqual(full({ role: 'background', lang: 'en' }), 'Background');
  assert.strictEqual(full({ ctx: ['Card'], base: 'Inner', role: 'bg' }), 'Card / Inner / hatter');
  assert.strictEqual(full({ ctx: [], base: 'Card', role: 'bg', lang: 'en' }), 'Card / background');
  assert.strictEqual(full({ base: 'Photo', role: 'raster' }), 'Photo [raszter]');
  assert.strictEqual(full({ base: 'Photo', role: 'raster', lang: 'en' }), 'Photo [raster]');
  assert.strictEqual(full({ base: 'Title', role: 'text-live', twin: true }), 'Title [szerkesztheto]');
  assert.strictEqual(full({ base: 'Title', role: 'text-live', twin: true, lang: 'en' }), 'Title [editable]');
  assert.strictEqual(full({ base: 'Title', role: 'text-outline' }), 'Title');
});
t('long names: max 120, middle segments shortened first, own name kept', () => {
  const ctx = ['Alpha'.repeat(10), 'Bravo'.repeat(10), 'Charlie'.repeat(10)];
  const r = full({ ctx, base: 'Leaf name', role: 'vector' });
  assert.ok(r.length <= 120, r.length + '');
  assert.ok(r.startsWith('Alpha'.repeat(10)));
  assert.ok(r.endsWith(' / Leaf name'));
  assert.ok(r.includes('...'));
});
t('very long single name hard-cut to 120', () => {
  assert.strictEqual(full({ base: 'x'.repeat(300), role: 'vector' }).length, 120);
});
t('buildPlan: duplicates get " 2", " 3"; auto-names reported; both mode doubles text', () => {
  const frame = {
    id: '1:1', type: 'FRAME', name: 'Hero', width: 100, height: 100, visible: true,
    fills: [{ type: 'SOLID', visible: true, opacity: 1 }], strokes: [], effects: [],
    children: [
      Object.assign(rect('Logo'), { id: '1:2', effects: [] }),
      Object.assign(rect('Logo'), { id: '1:3', effects: [] }),
      Object.assign(rect('Rectangle 9'), { id: '1:4', effects: [] }),
      Object.assign(txt('Hello'), { id: '1:5', effects: [], fills: [] })
    ]
  };
  const live = N.buildPlan(frame, 'live', 'hu');
  assert.deepStrictEqual(live.elements.map(e => e.layerName), ['Hatter', 'Logo', 'Logo 2', 'Teglalap', 'Hello']);
  assert.ok(live.display.some(w => w.code === 'AUTO_NAME_REPLACED' && w.params.to === 'Teglalap'));
  assert.ok(live.display.some(w => w.code === 'DUPLICATE_NAME'));
  const both = N.buildPlan(frame, 'both', 'en');
  const names = both.elements.map(e => e.layerName);
  assert.deepStrictEqual(names.slice(-2), ['Hello', 'Hello [editable]']);
  const twin = both.elements[both.elements.length - 1];
  assert.strictEqual(twin.hidden, true);
  assert.strictEqual(twin.role, 'text-live');
  assert.strictEqual(both.elements[both.elements.length - 2].role, 'text-outline');
  assert.strictEqual(both.elements[both.elements.length - 2].kind, 'vector');
});
t('buildPlan: exploded + group gives context path and bg element', () => {
  const inner = Object.assign(rect('Dot'), { id: '2:3', effects: [] });
  const card = Object.assign(group('+Card', [inner], 'FRAME'), { id: '2:2', fills: [{ type: 'SOLID', visible: true, opacity: 1 }], strokes: [], effects: [] });
  const frame = { id: '2:1', type: 'FRAME', name: 'F', width: 10, height: 10, visible: true, fills: [], strokes: [], effects: [], children: [card] };
  const plan = N.buildPlan(frame, 'live', 'hu');
  assert.deepStrictEqual(plan.elements.map(e => e.layerName), ['Card / hatter', 'Card / Dot']);
  assert.deepStrictEqual(plan.elements.map(e => e.role), ['bg', 'vector']);
});

t('asciiName: Hungarian accents', () => {
  assert.strictEqual(N.asciiName('\u00c1rv\u00edzt\u0171r\u0151 t\u00fck\u00f6rf\u00far\u00f3g\u00e9p'), 'Arvizturo tukorfurogep');
  assert.strictEqual(base(rect('\u00c1rv\u00edzt\u0171r\u0151 t\u00fck\u00f6rf\u00far\u00f3g\u00e9p')).name, 'Arvizturo tukorfurogep');
});
t('U+2028 / U+2029 / nbsp become a single space', () => {
  assert.strictEqual(base(txt('Egy\u2028sor\u2029tobb\u00a0szo', 'Group 1')).name, 'Egy sor tobb szo');
  assert.strictEqual(base(rect('A\u2028\u2028B')).name, 'A B');
});
t('Kep with accent -> Kep; other transliterations', () => {
  assert.strictEqual(N.asciiName('K\u00e9p'), 'Kep');
  assert.strictEqual(N.asciiName('Stra\u00dfe \u00e6 \u00f8 \u0142'), 'Strasse ae o l');
});
t('emoji-only names fall back to the type word', () => {
  assert.strictEqual(base({ type: 'ELLIPSE', name: '\ud83d\ude00\ud83d\udd25', visible: true }).name, 'Ellipszis');
  assert.strictEqual(base({ type: 'ELLIPSE', name: '\ud83d\ude00', visible: true }, 'en').name, 'Ellipse');
  assert.strictEqual(base(txt('\ud83d\ude00', 'Frame 3')).name, 'Szoveg');
});
t('dashes, ellipsis and curly quotes', () => {
  assert.strictEqual(N.asciiName('A \u2013 B \u2014 C\u2026 \u201cq\u201d \u2019s'), 'A - B - C... "q" \'s');
  assert.strictEqual(full({ ctx: ['Kártya'], base: 'Fej\u00e9c', role: 'raster' }), 'Kartya / Fejec [raszter]');
});
t('final names are ASCII even for long truncated names', () => {
  const r = full({ ctx: ['\u00c1'.repeat(60), '\u00c9'.repeat(60)], base: '\u0151'.repeat(30), role: 'vector' });
  assert.ok(/^[\x20-\x7e]*$/.test(r) && r.length <= 120, r);
});
t('preflight params have no U+2028', () => {
  const frame = { id: '9:1', type: 'FRAME', name: 'F', width: 1, height: 1, visible: true, fills: [], strokes: [], effects: [],
    children: [Object.assign(rect('Rectangle 1'), { id: '9:2', effects: [], name: 'Rect\u2028angle 1' })] };
  const plan = N.buildPlan(frame, 'live', 'hu');
  assert.ok(plan.display.every(w => Object.values(w.params).every(v => typeof v !== 'string' || !/[\u2028\u2029]/.test(v))));
});

t('one long text with U+2028 in both mode: 2 elements, names differ only by suffix, no duplicate', () => {
  const long = 'A F\u00e9ny H\u00e1za 1995 \u00f3ta ny\u00fajt mened\u00e9ket\u2028' + 'lorem ipsum dolor sit amet '.repeat(12);
  const frame = { id: '7:1', type: 'FRAME', name: 'F', width: 10, height: 10, visible: true, fills: [], strokes: [], effects: [],
    children: [Object.assign(txt(long), { id: '7:2', effects: [], fills: [] })] };
  const plan = N.buildPlan(frame, 'both', 'hu');
  assert.strictEqual(plan.elements.length, 2);
  const [out, live] = plan.elements.map(e => e.layerName);
  const suffix = ' [szerkesztheto]';
  assert.strictEqual(live, out + suffix);
  assert.ok(live.length <= 120 && out.length <= 120 - suffix.length);
  assert.ok(!plan.display.some(w => w.code === 'DUPLICATE_NAME'));
  assert.ok(!/[\u2028\u2029]/.test(out));
});
t('suffix survives truncation (raster too)', () => {
  const r = full({ base: 'x'.repeat(300), role: 'raster' });
  assert.ok(r.endsWith(' [raszter]') && r.length <= 120, r.length + '');
});

console.log(passed + ' tests passed');
