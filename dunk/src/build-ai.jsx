// Dunk: builds an .ai from a job folder (manifest.json + element files).
// args: [jobDir, aiPath, reportPath]  ->  returns "OK" or "ERR:<message>"
#target illustrator
(function (argv) {
  // J(): backslash -> forward slash; ExtendScript accepts C:/... on Windows
  function J(p) { return String(p).replace(/\\/g, "/"); }
  var jobDir = J(argv[0]), aiPathOrig = String(argv[1]), aiPath = J(argv[1]), reportPath = J(argv[2]);
  var TOL = 1;
  var prevUI = app.userInteractionLevel;
  var doc = null;
  var result = "OK";
  var report = {
    ok: false, aiPath: aiPathOrig, layers: [], removedClips: 0, unwrappedGroups: 0,
    deletedEmpty: 0, keptClips: [], textFrames: 0, warnings: []
  };

  // ---------- helpers ----------
  function readText(path) {
    var f = new File(path);
    if (!f.exists) throw new Error("Hianyzik a fajl: " + path);
    f.encoding = "UTF-8";
    f.open("r");
    var t = f.read();
    f.close();
    if (t.charCodeAt(0) === 0xFEFF) t = t.substr(1);
    return t;
  }
  function writeText(path, text) {
    var f = new File(path);
    f.encoding = "UTF-8";
    f.lineFeed = "Unix";
    if (!f.open("w")) throw new Error("Nem irhato: " + path);
    f.write(text);
    f.close();
  }
  function esc(s) {
    s = String(s);
    var o = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i), n = s.charCodeAt(i);
      if (c === "\\") o += "\\\\";
      else if (c === '"') o += '\\"';
      else if (c === "\n") o += "\\n";
      else if (c === "\r") o += "\\r";
      else if (c === "\t") o += "\\t";
      else if (n < 32) { var h = n.toString(16); o += "\\u" + "0000".substr(h.length) + h; }
      else o += c;
    }
    return '"' + o + '"';
  }
  function ser(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "string") return esc(v);
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    var i, parts = [];
    if (v instanceof Array) {
      for (i = 0; i < v.length; i++) parts.push(ser(v[i]));
      return "[" + parts.join(",") + "]";
    }
    for (var k in v) if (v.hasOwnProperty(k)) parts.push(esc(k) + ":" + ser(v[k]));
    return "{" + parts.join(",") + "}";
  }
  function writeReport() {
    try { writeText(reportPath, ser(report)); } catch (e) { /* nothing more to do */ }
  }
  function near(a, b, tol) { return Math.abs(a - b) <= tol; }
  function pad(i, n) { var s = String(i); while (s.length < n) s = "0" + s; return s; }

  // geometricBounds = [left, top, right, bottom], y up (top > bottom)
  function isAxisRect(p) {
    if (p.typename !== "PathItem") return false;
    var pts = p.pathPoints, n = pts.length;
    if (n === 5) {
      var a = pts[0].anchor, z = pts[4].anchor;
      if (!near(a[0], z[0], 0.01) || !near(a[1], z[1], 0.01)) return false;
      n = 4;
    }
    if (n !== 4) return false;
    var b = p.geometricBounds, i, j;
    for (i = 0; i < n; i++) {
      var an = pts[i].anchor, l = pts[i].leftDirection, r = pts[i].rightDirection;
      if (!near(an[0], l[0], 0.01) || !near(an[1], l[1], 0.01)) return false;
      if (!near(an[0], r[0], 0.01) || !near(an[1], r[1], 0.01)) return false;
      var okx = near(an[0], b[0], 0.5) || near(an[0], b[2], 0.5);
      var oky = near(an[1], b[1], 0.5) || near(an[1], b[3], 0.5);
      if (!okx || !oky) return false;
    }
    return true;
  }
  function sameRect(a, b, tol) {
    return near(a[0], b[0], tol) && near(a[1], b[1], tol) && near(a[2], b[2], tol) && near(a[3], b[3], tol);
  }
  function findClipPath(g) {
    for (var i = 0; i < g.pageItems.length; i++) {
      var it = g.pageItems[i];
      if (it.typename === "PathItem" && it.clipping) return it;
      if (it.typename === "CompoundPathItem" && it.pathItems.length && it.pathItems[0].clipping) return it;
    }
    return null;
  }
  function unionOthers(g, clip) {
    var u = null;
    for (var i = 0; i < g.pageItems.length; i++) {
      var it = g.pageItems[i];
      if (it === clip) continue;
      var b = it.geometricBounds;
      if (!u) u = [b[0], b[1], b[2], b[3]];
      else {
        if (b[0] < u[0]) u[0] = b[0];
        if (b[1] > u[1]) u[1] = b[1];
        if (b[2] > u[2]) u[2] = b[2];
        if (b[3] < u[3]) u[3] = b[3];
      }
    }
    return u;
  }

  // ---------- cleanup (CONTRACT section 5) ----------
  var abRect = null;
  function cleanPass(cont) {
    var changed = false, kids = [], i;
    for (i = 0; i < cont.pageItems.length; i++) kids.push(cont.pageItems[i]);
    for (i = 0; i < kids.length; i++) {
      var it = kids[i];
      try {
        var t = it.typename;
        if (t === "PathItem") {
          if (!it.clipping && !it.guides && !it.filled && !it.stroked) {
            it.remove(); report.deletedEmpty++; changed = true;
          }
        } else if (t === "GroupItem") {
          if (cleanPass(it)) changed = true;
          if (it.pageItems.length === 0) {
            it.remove(); report.deletedEmpty++; changed = true;
          } else if (it.clipped) {
            var clip = findClipPath(it);
            if (clip && clip.typename === "PathItem" && isAxisRect(clip)) {
              var cb = clip.geometricBounds, redundant = sameRect(cb, abRect, TOL);
              if (!redundant) {
                var u = unionOthers(it, clip);
                redundant = !!u && sameRect(cb, u, TOL);
              }
              if (redundant) {
                it.clipped = false;
                clip.remove();
                report.removedClips++; changed = true;
              }
            }
          } else if (it.pageItems.length === 1 && it.opacity === 100) {
            var child = it.pageItems[0];
            child.move(it, ElementPlacement.PLACEBEFORE);
            it.remove(); report.unwrappedGroups++; changed = true;
          }
        }
      } catch (e) { /* item vanished during the pass; the next pass re-reads the tree */ }
    }
    return changed;
  }
  function cleanLayer(layer) {
    for (var n = 0; n < 50; n++) if (!cleanPass(layer)) break;
  }
  function markRealClips(cont, layerName, acc) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      if (it.typename !== "GroupItem") continue;
      if (it.clipped) { it.name = layerName + " mask"; acc.count++; }
      markRealClips(it, layerName, acc);
    }
  }

  // ---------- alignment helpers ----------
  // finds the first clipped group whose clip rect is frame-sized; returns its bounds or null
  function findPageClip(cont, W, H) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      if (it.typename !== "GroupItem") continue;
      if (it.clipped) {
        var c = findClipPath(it);
        if (c && c.typename === "PathItem" && isAxisRect(c)) {
          var b = c.geometricBounds;
          if (near(b[2] - b[0], W, TOL) && near(b[1] - b[3], H, TOL)) return b;
        }
      }
      var r = findPageClip(it, W, H);
      if (r) return r;
    }
    return null;
  }
  // Illustrator reads SVG ids as latin-1: repair UTF-8 mojibake in item names
  function fixNames(it) {
    try {
      var n = it.name;
      if (n) {
        // ExtendScript's decodeURIComponent is lenient (turns o-acute into garbage), so only accept
        // a result that re-encodes to exactly the original name.
        if (/[\u00C2-\u00F4][\u0080-\u00BF]/.test(n)) {
          var r = decodeURIComponent(escape(n));
          if (r !== n && unescape(encodeURIComponent(r)) === n) it.name = r;
        }
      }
    } catch (e) { /* not mojibake: keep the original */ }
    if (it.typename === "GroupItem") for (var i = 0; i < it.pageItems.length; i++) fixNames(it.pageItems[i]);
  }
  // ---------- ASCII-only names (CONTRACT section 10 amendment 2) ----------
  var ACC_FROM = "\u00E1\u00E0\u00E2\u00E4\u00E3\u00E5\u0101\u0103\u0105\u00C1\u00C0\u00C2\u00C4\u00C3\u00C5\u0100\u0102\u0104" +
    "\u00E9\u00E8\u00EA\u00EB\u0113\u0119\u011B\u00C9\u00C8\u00CA\u00CB\u0112\u0118\u011A" +
    "\u00ED\u00EC\u00EE\u00EF\u012B\u0131\u00CD\u00CC\u00CE\u00CF\u012A\u0130" +
    "\u00F3\u00F2\u00F4\u00F6\u00F5\u0151\u014D\u00F8\u00D3\u00D2\u00D4\u00D6\u00D5\u0150\u014C\u00D8" +
    "\u00FA\u00F9\u00FB\u00FC\u0171\u016B\u016F\u00DA\u00D9\u00DB\u00DC\u0170\u016A\u016E" +
    "\u00E7\u010D\u0107\u00C7\u010C\u0106\u010F\u0111\u010E\u0110\u0142\u0141\u00F1\u0148\u0144\u00D1\u0147\u0143" +
    "\u0159\u0158\u0161\u015B\u0160\u015A\u0165\u0164\u00FD\u00FF\u00DD\u017E\u017A\u017C\u017D\u0179\u017B";
  var ACC_TO = "aaaaaaaaaAAAAAAAAA" + "eeeeeeeEEEEEEE" + "iiiiiiIIIIII" + "oooooooo" + "OOOOOOOO" + "uuuuuuuUUUUUUU" +
    "ccc" + "CCC" + "dd" + "DD" + "ll" + "nnn" + "NNN" + "rR" + "ssSSS" + "tT" + "yyY" + "zzzZZZ";
  function asciiName(s, fallback) {
    s = String(s);
    var o = "", i, c, n, k;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i); n = s.charCodeAt(i);
      if (n === 0xDF) o += "ss";
      else if (n === 0xE6) o += "ae";
      else if (n === 0xC6) o += "AE";
      else if (n === 0x2013 || n === 0x2014 || n === 0x2212) o += "-";
      else if (n === 0x2026) o += "...";
      else if (n === 0x2018 || n === 0x2019 || n === 0x201A || n === 0x2032) o += "'";
      else if (n === 0x201C || n === 0x201D || n === 0x201E || n === 0x2033) o += '"';
      else if (n === 0x2028 || n === 0x2029 || n === 0xA0 || /\s/.test(c)) o += " ";
      else if (n >= 32 && n < 127) o += c;
      else if (n >= 128 && (k = ACC_FROM.indexOf(c)) >= 0) o += ACC_TO.charAt(k);
      /* anything else is dropped */
    }
    o = o.replace(/ +/g, " ").replace(/^ | $/g, "");
    return o === "" ? (fallback || "Item") : o;
  }
  function asciiTree(cont) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      try {
        var n = String(it.name);
        if (n) { var a = asciiName(n, ""); if (a !== n) it.name = a; }
      } catch (e) {}
      if (it.typename === "GroupItem") asciiTree(it);
    }
  }

  // ---------- names inside layers (CONTRACT section 10) ----------
  var GENERIC = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Image|Union|Subtract|Intersect|Exclude|Component|Instance|Slice|Section|Boolean|Path|Text|Layer|Clip|Compound ?Path)( ?\d+)?$/i;
  var AUTO_WORD = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Image|Union|Subtract|Intersect|Exclude|Component|Instance|Slice|Section|Boolean)$/i;
  function isGeneric(n, base) {
    if (/^<.*>$/.test(n) || /^_x[0-9A-Fa-f]+_/.test(n) || GENERIC.test(n)) return true;
    var m = /^(.*)_\d+$/.exec(n);
    if (!m) return false;
    var x = m[1];   // SVG ids turn spaces into underscores
    x = asciiName(x, "");
    return AUTO_WORD.test(x) || x === base || x === base.replace(/ /g, "_");
  }
  function clearGeneric(cont, base) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      try {
        var n = String(it.name);
        if (n && !/ mask$/.test(n) && isGeneric(n, base)) it.name = "";
      } catch (e) {}
      if (it.typename === "GroupItem") clearGeneric(it, base);
    }
  }
  function collectFrames(cont, acc) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      if (it.typename === "TextFrame") acc.push(it);
      else if (it.typename === "GroupItem") collectFrames(it, acc);
    }
  }
  function nameLayerContents(layer, layerName, kind, lang) {
    var base = layerName;
    if (kind === "text") base = base.replace(/\s*\[(szerkesztheto|szerkeszthet\u0151|editable)\]\s*$/i, "");
    clearGeneric(layer, base);
    if (layer.pageItems.length === 1) {
      var top = layer.pageItems[0];
      if (!(top.typename === "GroupItem" && top.clipped)) top.name = base;
    }
    asciiTree(layer);
    if (kind === "text") {
      var fr = [];
      collectFrames(layer, fr);
      if (fr.length === 1) fr[0].name = base;
      else if (fr.length > 1) {
        fr.sort(function (a, b) { return b.geometricBounds[1] - a.geometricBounds[1]; });   // top line first
        for (var k = 0; k < fr.length; k++) {
          fr[k].name = base + " - " + (lang === "en" ? "line " + (k + 1) : (k + 1) + ". sor");
        }
      }
    }
  }
  function findNamed(cont, key) {
    for (var i = 0; i < cont.pageItems.length; i++) {
      var it = cont.pageItems[i];
      if (String(it.name).indexOf(key) >= 0) return it;
      if (it.typename === "GroupItem") { var r = findNamed(it, key); if (r) return r; }
    }
    return null;
  }

  try {
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

    // manifest
    var mf = eval("(" + readText(jobDir + "/manifest.json") + ")");
    if (!mf || !mf.frame || !mf.elements || !(mf.elements instanceof Array)) throw new Error("Ervenytelen manifest");
    var W = Number(mf.frame.width), H = Number(mf.frame.height);
    if (!(W > 0) || !(H > 0)) throw new Error("Ervenytelen frame meret");
    var els = mf.elements, i;
    var lang = mf.lang === "en" ? "en" : "hu";
    for (i = 0; i < els.length; i++) {
      if (!els[i].layerName || !els[i].file) throw new Error("Hianyos elem: #" + i);
      if (!new File(J(jobDir + "/" + els[i].file)).exists) throw new Error("Hianyzik: " + els[i].file);
    }

    // document
    doc = app.documents.add(DocumentColorSpace.RGB, W, H);
    abRect = doc.artboards[0].artboardRect;       // [left, top, right, bottom], observed [0,H,W,0]
    var abL = abRect[0], abT = abRect[1];
    var defaultLayer = doc.layers[0];

    var lnames = [];
    for (i = 0; i < els.length; i++) lnames.push(asciiName(els[i].layerName, "Layer"));
    var layers = [];
    for (i = 0; i < els.length; i++) {
      var layer = (i === 0) ? defaultLayer : doc.layers.add();   // layers.add() stacks on top
      layer.name = lnames[i];
      layers.push(layer);
    }

    // import
    for (i = 0; i < els.length; i++) {
      var el = els[i], L = layers[i], fpath = J(jobDir + "/" + el.file);
      doc.activeLayer = L;
      if (el.format === "png") {
        var bd = el.bounds;
        if (el.placement !== "bounds" || !bd) bd = { x: 0, y: 0, width: W, height: H };
        var p = L.placedItems.add();
        p.file = new File(fpath);
        p.width = bd.width;
        p.height = bd.height;
        p.left = abL + bd.x;
        p.top = abT - bd.y;
        p.embed();
      } else {
        var tmp = null, src = fpath, markKey = "NTPmark";
        if (el.format === "svg") {
          // Illustrator centres an SVG by its content, so plant an invisible frame-sized marker
          // rect and measure it to learn where the page's top-left landed.
          var svg = readText(fpath);
          var m = /<svg\b[^>]*>/.exec(svg);
          if (m) {
            var mk = '<rect id="' + markKey + '" x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>';
            var cut = m.index + m[0].length;
            tmp = jobDir + "/__tmp_" + pad(i, 3) + ".svg";
            writeText(tmp, svg.substr(0, cut) + mk + svg.substr(cut));
            src = tmp;
          }
        }
        var g;
        try {
          g = doc.groupItems.createFromFile(new File(src));
        } finally {
          if (tmp) { try { new File(tmp).remove(); } catch (e2) {} }
        }
        g.move(L, ElementPlacement.PLACEATBEGINNING);

        var pageTL = null;
        if (el.format === "svg") {
          var mkItem = findNamed(g, markKey);
          if (mkItem) {
            var mb = mkItem.geometricBounds;
            pageTL = [mb[0], mb[1]];
            mkItem.remove();
          }
          fixNames(g);
        } else {
          var pb = findPageClip(g, W, H);
          if (pb) pageTL = [pb[0], pb[1]];
        }
        if (!pageTL) {
          report.warnings.push(el.layerName + ": nem talaltam oldalhatart, felteteles igazitas");
          var gb = g.geometricBounds;
          pageTL = el.format === "svg" ? [gb[0], gb[1]] : [abL, abT];
        }
        var dx = abL - pageTL[0], dy = abT - pageTL[1];
        if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) g.translate(dx, dy);
      }
    }

    // cleanup
    for (i = 0; i < els.length; i++) {
      cleanLayer(layers[i]);
      var acc = { count: 0 };
      markRealClips(layers[i], lnames[i], acc);
      if (acc.count) report.keptClips.push({ layer: lnames[i], count: acc.count });
      nameLayerContents(layers[i], lnames[i], String(els[i].kind), lang);
      report.layers.push({ name: lnames[i], kind: String(els[i].kind), items: layers[i].pageItems.length });
    }
    report.textFrames = doc.textFrames.length;

    // hidden elements: very last step before save (hidden layers cannot be edited)
    for (i = 0; i < els.length; i++) {
      if (els[i].hidden === true) { layers[i].locked = false; layers[i].visible = false; }
    }

    // save
    var parent = new File(aiPath).parent;
    if (!parent.exists) parent.create();
    var so = new IllustratorSaveOptions();
    so.pdfCompatible = true;
    doc.saveAs(new File(aiPath), so);
    report.ok = true;
  } catch (e) {
    result = "ERR:" + (e && e.message ? e.message : String(e)) + (e && e.line ? " (line " + e.line + ")" : "");
    report.ok = false;
    report.error = result.substr(4);
  } finally {
    if (doc) { try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) {} }
    try { app.userInteractionLevel = prevUI; } catch (e4) {}
    writeReport();
    try { writeText(jobDir + "/result.txt", result); } catch (e5) {}
  }
  return result;
})((function (a) {
  // __JM_ARGS is a global of Illustrator's persistent engine: consume it once, so a later
  // osascript call (which passes real arguments) never picks up a stale value.
  if (typeof __JM_ARGS === "undefined" || __JM_ARGS === null) return a;
  var g = __JM_ARGS; __JM_ARGS = null; return g;
})(arguments));
