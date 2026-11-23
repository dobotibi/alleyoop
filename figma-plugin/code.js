// Alleyoop - Figma plugin main thread (ES2017, no ?. / ??)
'use strict';

figma.showUI(__html__, { width: 320, height: 480, themeColors: true });

var VALID_TYPES = { FRAME: 1, COMPONENT: 1, INSTANCE: 1 };
var textMode = 'live'; // 'live' | 'outline' | 'both'
var saveMode = 'default'; // 'default' | 'ask'
var lang = null; // 'hu' | 'en' | null (UI picks default)
var busy = false;
var cancelled = false;
var pendingAck = null; // { frameId, resolve }

// ---------------------------------------------------------------- helpers

function post(msg) {
  figma.ui.postMessage(msg);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function hasVisiblePaint(paints) {
  if (!Array.isArray(paints)) return false;
  for (var i = 0; i < paints.length; i++) {
    var p = paints[i];
    if (p.visible !== false && (p.opacity === undefined || p.opacity > 0)) return true;
  }
  return false;
}

function hasChildren(node) {
  return 'children' in node && node.children.length > 0;
}

function coded(code, params) {
  var e = new Error(code);
  e.i18nCode = code;
  e.i18nParams = params || {};
  return e;
}

function nodeAt(root, path) {
  var n = root;
  for (var i = 0; i < path.length; i++) {
    if (!n || !('children' in n)) return null;
    n = n.children[path[i]];
  }
  return n || null;
}

function cleanLayerName(name) {
  var s = String(name).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/[\u0000-\u001f]/g, ' ').trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || 'Layer';
}

function sanitizeFile(name) {
  var s = String(name).replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || 'Layer';
}

function isPlusNode(n) {
  return (n.type === 'GROUP' || n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') &&
    n.name.charAt(0) === '+' && 'children' in n;
}

// ---------------------------------------------------------------- layer naming (pure; contract §10)

var AUTO_NAME_RE = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Image|Union|Subtract|Intersect|Exclude|Component|Instance|Slice|Section|Boolean)( \d+)?$/i;

// Words that end up inside layer names (data, not UI chrome). ASCII only (contract section 10, amendment 2).
var NAME_WORDS = {
  hu: {
    FRAME: 'Keret', GROUP: 'Csoport', RECTANGLE: 'Teglalap', ELLIPSE: 'Ellipszis', VECTOR: 'Vektor',
    LINE: 'Vonal', POLYGON: 'Sokszog', STAR: 'Csillag', BOOLEAN_OPERATION: 'Alakzat',
    COMPONENT: 'Komponens', INSTANCE: 'Peldany', TEXT: 'Szoveg', OTHER: 'Alakzat',
    image: 'Kep', group: 'Csoport', background: 'Hatter', bgWord: 'hatter', raster: 'raszter', live: 'szerkesztheto'
  },
  en: {
    FRAME: 'Frame', GROUP: 'Group', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse', VECTOR: 'Vector',
    LINE: 'Line', POLYGON: 'Polygon', STAR: 'Star', BOOLEAN_OPERATION: 'Shape',
    COMPONENT: 'Component', INSTANCE: 'Instance', TEXT: 'Text', OTHER: 'Shape',
    image: 'Image', group: 'Group', background: 'Background', bgWord: 'background', raster: 'raster', live: 'editable'
  }
};

function nameWords(lang) {
  return lang === 'en' ? NAME_WORDS.en : NAME_WORDS.hu;
}

function collapseWs(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Plain-ASCII form of a name: transliterates accents, maps typographic characters, drops the rest.
function asciiName(str) {
  var s = String(str === undefined || str === null ? '' : str);
  s = s.replace(/\u00df/g, 'ss').replace(/\u00e6/g, 'ae').replace(/\u00c6/g, 'AE')
    .replace(/\u00f8/g, 'o').replace(/\u00d8/g, 'O').replace(/\u0142/g, 'l').replace(/\u0141/g, 'L');
  s = s.replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...')
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'").replace(/[\u201c\u201d\u201e\u201f]/g, '"');
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/\s+/g, ' '); // also U+2028 / U+2029 / nbsp
  s = s.replace(/[^\x20-\x7e]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// first non-empty line (soft breaks U+2028/2029 count as spaces), ASCII, cut to max chars + "..."
function truncText(s, max) {
  var lines = String(s === undefined || s === null ? '' : s).split(/\r\n|\r|\n/);
  var line = '';
  for (var i = 0; i < lines.length; i++) {
    line = asciiName(lines[i]);
    if (line) break;
  }
  if (line.length > max) line = line.slice(0, max).replace(/\s+$/, '') + '...';
  return line;
}

function hasImageFill(node) {
  if (Array.isArray(node.fills)) {
    for (var i = 0; i < node.fills.length; i++) {
      if (node.fills[i].type === 'IMAGE' && node.fills[i].visible !== false) return true;
    }
  }
  if (node.children) {
    for (var j = 0; j < node.children.length; j++) {
      if (node.children[j].visible !== false && hasImageFill(node.children[j])) return true;
    }
  }
  return false;
}

function firstVisibleText(node) {
  if (!node.children) return null;
  for (var i = 0; i < node.children.length; i++) {
    var c = node.children[i];
    if (c.visible === false) continue;
    if (c.type === 'TEXT') return c;
    var r = firstVisibleText(c);
    if (r) return r;
  }
  return null;
}

// Base name of a node (rules 1 + 2). Returns { name, replaced, from }.
function baseNameFor(node, lang, isPlus) {
  var w = nameWords(lang);
  var raw = String(node.name === undefined || node.name === null ? '' : node.name);
  if (isPlus) raw = raw.replace(/^\++\s*/, '');
  var orig = collapseWs(raw);
  var name = asciiName(raw);
  if (name && !AUTO_NAME_RE.test(name)) return { name: name, replaced: false, from: orig };
  var to = '';
  if (node.type === 'TEXT') {
    to = truncText(node.characters, 32) || w.TEXT;
  } else {
    var tx = node.children ? firstVisibleText(node) : null;
    var label = tx ? truncText(tx.characters, 24) : '';
    if (label) to = w.group + ': ' + label;
    else if (hasImageFill(node)) to = w.image;
    else to = w[node.type] || w.OTHER;
  }
  return { name: to, replaced: true, from: orig };
}

// Joins context segments with " / ", max chars; middle segments are shortened first.
function joinSegments(segs, max) {
  var s = segs.join(' / ');
  if (s.length <= max) return s;
  var i;
  if (segs.length > 2) {
    segs = segs.slice();
    for (i = 1; i < segs.length - 1; i++) {
      if (segs[i].length > 8) segs[i] = segs[i].slice(0, 8) + '...';
    }
    s = segs.join(' / ');
    if (s.length <= max) return s;
    for (i = 1; i < segs.length - 1; i++) segs[i] = '...';
    s = segs.join(' / ');
    if (s.length <= max) return s;
  }
  if (segs.length > 1) {
    var rest = segs.slice(1).join(' / ');
    var room = max - 3 - rest.length;
    if (room >= 1) return segs[0].slice(0, room) + ' / ' + rest;
  }
  return s.slice(0, max);
}

// Final layer name (rules 3 + 4). parts: { ctx: [names], base, role, twin (hidden live twin in both mode), lang }
function composeLayerName(parts) {
  var w = nameWords(parts.lang);
  var ctx = [];
  for (var ci = 0; ci < (parts.ctx || []).length; ci++) ctx.push(asciiName(parts.ctx[ci]) || w.OTHER);
  var role = parts.role;
  var pbase = asciiName(parts.base) || w.OTHER;
  if (role === 'background') return w.background;
  var segs = ctx.slice();
  var suffix = ''; // always kept: the base is truncated first, then the suffix is appended
  var reserve = 0; // room kept free so a text outline fits the same base as its live twin
  if (role === 'bg') {
    segs.push(pbase);
    segs.push(w.bgWord);
  } else {
    segs.push(pbase);
    if (role === 'raster') suffix = ' [' + w.raster + ']';
    else if (role === 'text-live' && parts.twin) suffix = ' [' + w.live + ']';
    else if (role === 'text-outline' && parts.reserveTwin) reserve = (' [' + w.live + ']').length;
  }
  var head = joinSegments(segs, 120 - suffix.length - reserve).replace(/\s+$/, '');
  return asciiName(head + suffix);
}

function getSelectionFrames() {
  var out = [];
  var seen = {};
  var sel = figma.currentPage.selection;
  function add(n) {
    if (!seen[n.id]) {
      seen[n.id] = true;
      out.push(n);
    }
  }
  for (var i = 0; i < sel.length; i++) {
    var n = sel[i];
    if (VALID_TYPES[n.type]) {
      add(n);
    } else if (n.type === 'SECTION') {
      for (var j = 0; j < n.children.length; j++) {
        if (VALID_TYPES[n.children[j].type]) add(n.children[j]);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- pre-flight / plan (original, read-only)

function hasEffect(node, types) {
  if (!Array.isArray(node.effects)) return false;
  for (var i = 0; i < node.effects.length; i++) {
    var e = node.effects[i];
    if (e.visible !== false && types.indexOf(e.type) !== -1) return true;
  }
  return false;
}

function containsBlur(node) {
  if (hasEffect(node, ['LAYER_BLUR', 'BACKGROUND_BLUR'])) return true;
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.visible && containsBlur(c)) return true;
    }
  }
  return false;
}

function collectTexts(node, path, out) {
  if (node.type === 'TEXT') {
    out.push({ node: node, path: path });
    return;
  }
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.visible) collectTexts(c, path.concat([i]), out);
    }
  }
}

// true if the node has anything to draw besides TEXT nodes
function nonTextContent(node) {
  if (node.type === 'TEXT') return false;
  if (node.type === 'SLICE') return false;
  if (node.type === 'BOOLEAN_OPERATION') return true;
  if ('children' in node) {
    var t = node.type;
    if ((t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE') &&
      (hasVisiblePaint(node.fills) || hasVisiblePaint(node.strokes))) return true;
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (c.visible && nonTextContent(c)) return true;
    }
    return false;
  }
  return true;
}

// Scans a subtree for shadow / mask / mixed text warnings.
function scanSubtree(node, el, ctx, insideRaster) {
  if (hasEffect(node, ['DROP_SHADOW'])) {
    ctx.warn(el, 'warn', 'DROP_SHADOW', { name: node.name });
  }
  if (node.type === 'TEXT' && !insideRaster) {
    var mixed = false;
    try {
      mixed = node.fontName === figma.mixed || node.fills === figma.mixed;
    } catch (e) { mixed = false; }
    if (mixed) {
      ctx.warn(el, 'warn', 'MIXED_TEXT', { name: node.name });
    }
  }
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      if (!c.visible) continue;
      if ('isMask' in c && c.isMask) {
        ctx.warn(el, 'info', 'MASK_NESTED', { name: c.name });
      }
      scanSubtree(c, el, ctx, insideRaster);
    }
  }
}

function buildPlan(frame, mode, lang) {
  var elements = [];
  var warnings = []; // {el, level, code, params}
  var hiddenCount = 0;
  var splitText = mode === 'live' || mode === 'both';

  var ctx = {
    warn: function (el, level, code, params) {
      var clean = {};
      var src = params || {};
      for (var key in src) {
        clean[key] = typeof src[key] === 'string' ? src[key].replace(/[\u2028\u2029]/g, ' ') : src[key];
      }
      warnings.push({ el: el, level: level, code: code, params: clean });
    }
  };

  function nameInfo(node, isPlus, el) {
    var info = baseNameFor(node, lang, isPlus);
    if (info.replaced && el) {
      ctx.warn(el, 'info', 'AUTO_NAME_REPLACED', { from: info.from, to: info.name });
    }
    return info;
  }

  function addElement(c, path, ctxNames) {
    var blur = containsBlur(c);
    if (blur) {
      var rel = { id: c.id, kind: 'raster', role: 'raster', path: path, ctx: ctxNames };
      rel.base = nameInfo(c, false, rel).name;
      elements.push(rel);
      ctx.warn(rel, 'warn', 'BLUR_RASTERIZED', { name: c.name });
      scanSubtree(c, rel, ctx, true);
      return;
    }
    if (splitText) {
      var texts = [];
      collectTexts(c, path, texts);
      var vel = null;
      var firstNew = elements.length;
      if (nonTextContent(c)) {
        vel = { id: c.id, kind: 'vector', role: 'vector', path: path, textPaths: [], ctx: ctxNames };
        vel.base = nameInfo(c, false, vel).name;
        for (var t = 0; t < texts.length; t++) vel.textPaths.push(texts[t].path);
        elements.push(vel);
      }
      for (var k = 0; k < texts.length; k++) {
        var tn = texts[k].node;
        if (mode === 'both') {
          var oel = { id: tn.id, kind: 'vector', role: 'text-outline', path: texts[k].path, ctx: ctxNames };
          oel.base = nameInfo(tn, false, oel).name;
          elements.push(oel);
          var lel = { id: tn.id + '#live', kind: 'text', role: 'text-live', hidden: true, path: texts[k].path, ctx: ctxNames, base: oel.base };
          elements.push(lel);
        } else {
          var tel = { id: tn.id, kind: 'text', role: 'text-live', path: texts[k].path, ctx: ctxNames };
          tel.base = nameInfo(tn, false, tel).name;
          elements.push(tel);
        }
      }
      scanSubtree(c, vel || (elements.length > firstNew ? elements[firstNew] : null), ctx, false);
    } else {
      var el = { id: c.id, kind: 'vector', role: 'vector', path: path, textPaths: [], ctx: ctxNames };
      el.base = nameInfo(c, false, el).name;
      elements.push(el);
      scanSubtree(c, el, ctx, false);
    }
  }

  function walk(parent, prefix, ctxNames) {
    for (var i = 0; i < parent.children.length; i++) {
      var c = parent.children[i];
      if (!c.visible) { hiddenCount++; continue; }
      if (c.type === 'SLICE') continue;
      var path = prefix.concat([i]);
      if (isPlusNode(c)) {
        ctx.warn(null, 'info', 'PLUS_EXPLODED', { name: c.name });
        var info = baseNameFor(c, lang, true);
        if (info.replaced) ctx.warn(null, 'info', 'AUTO_NAME_REPLACED', { from: info.from, to: info.name });
        var t = c.type;
        if ((t === 'FRAME' || t === 'COMPONENT' || t === 'INSTANCE') &&
          (hasVisiblePaint(c.fills) || hasVisiblePaint(c.strokes))) {
          elements.push({
            id: c.id + '#bg', kind: 'vector', role: 'bg', path: path, textPaths: [], hideAll: true, clearAfter: true,
            ctx: ctxNames, base: info.name
          });
        }
        walk(c, path, ctxNames.concat([info.name]));
        continue;
      }
      if ('isMask' in c && c.isMask) {
        ctx.warn(null, 'warn', 'MASK_TOP', { name: c.name });
      }
      addElement(c, path, ctxNames);
    }
  }

  walk(frame, [], []);

  if (hiddenCount > 0) {
    ctx.warn(null, 'info', 'HIDDEN_SKIPPED', { count: hiddenCount });
  }

  // background first
  if (hasVisiblePaint(frame.fills) || hasVisiblePaint(frame.strokes)) {
    elements.unshift({ id: 'bg', kind: 'background', role: 'background', path: [], ctx: [], base: '' });
  }

  // final layer names, unique names, file names
  var used = {};
  var padLen = elements.length > 99 ? 3 : 2;
  for (var i = 0; i < elements.length; i++) {
    var el2 = elements[i];
    var base = cleanLayerName(composeLayerName({ ctx: el2.ctx, base: el2.base, role: el2.role, twin: !!el2.hidden, reserveTwin: mode === 'both' && el2.role === 'text-outline', lang: lang }));
    var name = base;
    var n = 2;
    var renamed = false;
    while (used[name]) {
      var suffix = ' ' + n;
      name = base.slice(0, 120 - suffix.length) + suffix;
      n++;
      renamed = true;
    }
    used[name] = true;
    el2.layerName = name;
    if (renamed) {
      ctx.warn(el2, 'info', 'DUPLICATE_NAME', { name: name });
    }
    el2.format = el2.kind === 'raster' ? 'png' : (el2.kind === 'text' ? 'svg' : 'pdf');
    var prefix = String(i);
    while (prefix.length < padLen) prefix = '0' + prefix;
    el2.file = prefix + '_' + sanitizeFile(name) + '.' + el2.format;
  }

  var preflight = [];
  var display = [];
  for (var w = 0; w < warnings.length; w++) {
    var wr = warnings[w];
    var elementId = wr.el ? wr.el.id : frame.id;
    preflight.push({ elementId: elementId, level: wr.level, code: wr.code, params: wr.params });
    display.push({ level: wr.level, code: wr.code, params: wr.params });
  }

  return { elements: elements, preflight: preflight, display: display };
}

// ---------------------------------------------------------------- selection -> UI

function postSelection() {
  var frames = getSelectionFrames();
  var list = [];
  for (var i = 0; i < frames.length; i++) {
    var f = frames[i];
    var item = { id: f.id, name: f.name, width: round2(f.width), height: round2(f.height), elementCount: 0, warnings: [] };
    try {
      var plan = buildPlan(f, textMode, lang || 'hu');
      item.elementCount = plan.elements.length;
      item.warnings = plan.display;
    } catch (e) {
      item.warnings = [{ level: 'warn', code: 'PLAN_FAILED', params: { detail: String(e && e.message ? e.message : e) } }];
    }
    list.push(item);
  }
  post({ type: 'selection', frames: list });
}

// ---------------------------------------------------------------- export

function recordBase(node, base) {
  if ('children' in node) {
    for (var i = 0; i < node.children.length; i++) {
      var c = node.children[i];
      base[c.id] = c.visible;
      recordBase(c, base);
    }
  }
}

// Visibility: only the path to the target (+ target subtree) stays visible.
function applyVisibility(clone, base, pathNodes, target, hideIds, hideAll) {
  var anc = {};
  for (var i = 0; i < pathNodes.length; i++) anc[pathNodes[i].id] = true;

  function restoreDesc(n) {
    if (!('children' in n)) return;
    for (var j = 0; j < n.children.length; j++) {
      var ch = n.children[j];
      if (hideAll || hideIds[ch.id]) {
        ch.visible = false;
      } else {
        ch.visible = base[ch.id];
        restoreDesc(ch);
      }
    }
  }
  function visit(n) {
    for (var j = 0; j < n.children.length; j++) {
      var c = n.children[j];
      if (target && c.id === target.id) {
        c.visible = base[c.id];
        restoreDesc(c);
      } else if (anc[c.id]) {
        c.visible = base[c.id];
        visit(c);
      } else {
        c.visible = false;
      }
    }
  }
  visit(clone);
}

function clearPaint(node) {
  if ('fills' in node && node.type !== 'TEXT') node.fills = [];
  if ('strokes' in node) node.strokes = [];
  if ('effects' in node) node.effects = [];
}

async function exportFrameFiles(frame, frameName, onProgress, meta) {
  var plan = buildPlan(frame, textMode, meta.lang);
  var total = plan.elements.length;
  var clone = frame.clone();
  var files = [];
  var manifestElements = [];
  try {
    figma.currentPage.appendChild(clone);
    if ('clipsContent' in clone) clone.clipsContent = true;

    var base = {};
    recordBase(clone, base);
    var t = clone.absoluteTransform;
    var offX = t[0][2];
    var offY = t[1][2];

    for (var i = 0; i < total; i++) {
      var el = plan.elements[i];
      onProgress(i, total);
      var entry = {
        id: el.id,
        layerName: el.layerName,
        kind: el.kind,
        file: el.file,
        format: el.format,
        placement: 'fullframe',
        role: el.role
      };
      if (el.hidden) entry.hidden = true;
      var bytes;

      if (el.kind === 'background') {
        var k;
        for (k = 0; k < clone.children.length; k++) clone.children[k].visible = false;
        bytes = await clone.exportAsync({ format: 'PDF' });
        clearPaint(clone);
      } else {
        var pathNodes = [];
        var cur = clone;
        for (var p = 0; p < el.path.length; p++) {
          cur = cur.children[el.path[p]];
          if (!cur) throw coded('ERR_LAYER_NOT_FOUND', { name: el.layerName });
          pathNodes.push(cur);
        }
        var target = cur;
        var hideIds = {};
        if (el.textPaths) {
          for (var h = 0; h < el.textPaths.length; h++) {
            var tn = nodeAt(clone, el.textPaths[h]);
            if (tn) hideIds[tn.id] = true;
          }
        }
        applyVisibility(clone, base, pathNodes, target, hideIds, !!el.hideAll);

        if (el.kind === 'raster') {
          var rb = target.absoluteRenderBounds || target.absoluteBoundingBox;
          if (!rb) throw coded('ERR_NO_BOUNDS', { name: el.layerName });
          bytes = await target.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
          entry.placement = 'bounds';
          entry.bounds = {
            x: round2(rb.x - offX),
            y: round2(rb.y - offY),
            width: round2(rb.width),
            height: round2(rb.height)
          };
          entry.scale = 2;
        } else if (el.kind === 'text' || el.role === 'text-outline') {
          // drop ancestor paints so only the glyphs end up in the output
          for (var a = 0; a < pathNodes.length - 1; a++) {
            if (pathNodes[a].type !== 'GROUP') clearPaint(pathNodes[a]);
          }
          if (el.kind === 'text') {
            bytes = await clone.exportAsync({ format: 'SVG', svgOutlineText: false, svgIdAttribute: true });
          } else {
            bytes = await clone.exportAsync({ format: 'PDF' });
          }
        } else {
          bytes = await clone.exportAsync({ format: 'PDF' });
          if (el.clearAfter) clearPaint(target);
        }
      }

      files.push({ name: el.file, data: bytes });
      manifestElements.push(entry);
    }
    onProgress(total, total);

    var manifest = {
      version: 1,
      frame: { id: frame.id, name: frameName, width: round2(frame.width), height: round2(frame.height) },
      batch: { id: meta.batchId, index: meta.index, total: meta.total, saveMode: meta.saveMode },
      lang: meta.lang,
      options: { textMode: textMode },
      elements: manifestElements,
      preflight: plan.preflight
    };
    return { manifest: manifest, files: files };
  } finally {
    try { clone.remove(); } catch (e) { /* already gone */ }
  }
}

function waitForAck(frameId) {
  return new Promise(function (resolve) {
    pendingAck = { frameId: frameId, resolve: resolve };
  });
}

async function runExport(ids, batchId, saveMode, lang) {
  if (busy) return;
  busy = true;
  cancelled = false;
  try {
    var frames = [];
    var seenNames = {};
    for (var i = 0; i < ids.length; i++) {
      var node = await figma.getNodeByIdAsync(ids[i]);
      if (!node || !VALID_TYPES[node.type]) {
        post({ type: 'frame-error', frameId: ids[i], code: 'ERR_FRAME_GONE', params: {}, detail: '' });
        continue;
      }
      var nm = String(node.name).replace(/[\u2028\u2029]/g, ' ');
      var uniq = nm;
      var c = 2;
      while (seenNames[uniq]) { uniq = nm + ' (' + c + ')'; c++; }
      seenNames[uniq] = true;
      frames.push({ node: node, name: uniq });
    }

    for (var f = 0; f < frames.length; f++) {
      var fr = frames[f];
      if (cancelled) {
        for (var r = f; r < frames.length; r++) post({ type: 'frame-cancelled', frameId: frames[r].node.id });
        break;
      }
      post({ type: 'frame-status', frameId: fr.node.id, stage: 'exporting', done: 0, total: 0 });
      var result = null;
      try {
        result = await exportFrameFiles(fr.node, fr.name, function (done, total) {
          post({ type: 'frame-status', frameId: fr.node.id, stage: 'exporting', done: done, total: total });
        }, { batchId: batchId, index: f, total: frames.length, saveMode: saveMode, lang: lang });
      } catch (e) {
        post({
          type: 'frame-error', frameId: fr.node.id,
          code: e && e.i18nCode ? e.i18nCode : 'ERR_EXPORT',
          params: e && e.i18nParams ? e.i18nParams : {},
          detail: e && e.i18nCode ? '' : String(e && e.message ? e.message : e)
        });
        continue;
      }
      var ackP = waitForAck(fr.node.id);
      post({ type: 'frame-data', frameId: fr.node.id, manifest: result.manifest, files: result.files });
      result = null;
      await ackP;
    }
  } finally {
    busy = false;
    pendingAck = null;
    post({ type: 'batch-done' });
  }
}

// ---------------------------------------------------------------- messages

var DOWNLOAD_URL = 'https://dobotibi.github.io/alleyoop/';

figma.ui.onmessage = function (msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'ready') {
    post({ type: 'init', textMode: textMode, saveMode: saveMode, lang: lang });
    postSelection();
  } else if (msg.type === 'open-download') {
    figma.openExternal(DOWNLOAD_URL);
  } else if (msg.type === 'set-save-mode') {
    if (msg.mode === 'default' || msg.mode === 'ask') {
      saveMode = msg.mode;
      figma.clientStorage.setAsync('saveMode', saveMode).catch(function () {});
    }
  } else if (msg.type === 'set-lang') {
    if (msg.lang === 'hu' || msg.lang === 'en') {
      lang = msg.lang;
      if (msg.persist !== false) figma.clientStorage.setAsync('lang', lang).catch(function () {});
      if (!busy) postSelection();
    }
  } else if (msg.type === 'set-text-mode') {
    if (msg.mode === 'live' || msg.mode === 'outline' || msg.mode === 'both') {
      textMode = msg.mode;
      figma.clientStorage.setAsync('textMode', textMode).catch(function () {});
      if (!busy) postSelection();
    }
  } else if (msg.type === 'export') {
    runExport(msg.frameIds || [], msg.batchId, msg.saveMode === 'ask' ? 'ask' : 'default', msg.lang === 'en' ? 'en' : 'hu').catch(function (e) {
      post({ type: 'fatal', detail: String(e && e.message ? e.message : e) });
    });
  } else if (msg.type === 'frame-ack') {
    if (pendingAck && pendingAck.frameId === msg.frameId) {
      var r = pendingAck.resolve;
      pendingAck = null;
      r();
    }
  } else if (msg.type === 'cancel') {
    cancelled = true;
  }
};

figma.on('selectionchange', function () {
  if (!busy) postSelection();
});
figma.on('currentpagechange', function () {
  if (!busy) postSelection();
});

Promise.all([
  figma.clientStorage.getAsync('textMode'),
  figma.clientStorage.getAsync('saveMode'),
  figma.clientStorage.getAsync('lang')
]).then(function (v) {
  if (v[0] === 'live' || v[0] === 'outline' || v[0] === 'both') textMode = v[0];
  if (v[1] === 'default' || v[1] === 'ask') saveMode = v[1];
  if (v[2] === 'hu' || v[2] === 'en') lang = v[2];
}).catch(function () {}).then(function () {
  post({ type: 'init', textMode: textMode, saveMode: saveMode, lang: lang });
  postSelection();
});

// Node test hook (the Figma sandbox has no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AUTO_NAME_RE: AUTO_NAME_RE,
    asciiName: asciiName,
    baseNameFor: baseNameFor,
    composeLayerName: composeLayerName,
    joinSegments: joinSegments,
    truncText: truncText,
    buildPlan: buildPlan
  };
}
