// Dumps the object tree of a file opened in Illustrator (or the doc imported via createFromFile).
// Usage (args): [inputPath, outputTxtPath, mode] where mode = "open" | "import"
#target illustrator
(function (argv) {
  var inPath = argv[0], outPath = argv[1], mode = argv[2] || "open";
  var lines = [];
  function r(n) { return Math.round(n * 10) / 10; }
  function b(it) { try { var g = it.geometricBounds; return "[" + r(g[0]) + "," + r(g[1]) + "," + r(g[2]) + "," + r(g[3]) + "]"; } catch (e) { return "[?]"; } }
  function fill(it) {
    try {
      if (!it.filled) return "nofill";
      var c = it.fillColor;
      if (c.typename === "RGBColor") return "rgb(" + r(c.red) + "," + r(c.green) + "," + r(c.blue) + ")";
      if (c.typename === "GrayColor") return "gray(" + r(c.gray) + ")";
      return c.typename;
    } catch (e) { return "?"; }
  }
  function walk(it, d) {
    var pad = new Array(d + 1).join("  ");
    var t = it.typename, s = pad + t;
    if (it.name) s += ' "' + it.name + '"';
    s += " " + b(it);
    if (t === "GroupItem") s += " clipped=" + it.clipped + " n=" + it.pageItems.length + " opacity=" + it.opacity;
    if (t === "PathItem" || t === "CompoundPathItem") {
      var p = t === "PathItem" ? it : (it.pathItems.length ? it.pathItems[0] : null);
      if (p) s += " clipping=" + p.clipping + " pts=" + (t === "PathItem" ? it.pathPoints.length : "-") + " " + fill(p) + " stroked=" + p.stroked;
      s += " opacity=" + it.opacity;
    }
    if (t === "TextFrame") s += ' text="' + it.contents.substr(0, 40) + '"';
    lines.push(s);
    if (t === "GroupItem") for (var i = 0; i < it.pageItems.length; i++) walk(it.pageItems[i], d + 1);
  }
  var doc, created = false;
  if (mode === "import") {
    doc = app.documents.add(DocumentColorSpace.RGB, 1920, 1080); created = true;
    var g = doc.groupItems.createFromFile(new File(inPath));
    lines.push("createFromFile -> " + g.typename);
  } else {
    doc = app.open(new File(inPath)); created = true;
  }
  lines.push("artboard " + doc.artboards[0].artboardRect.join(","));
  for (var L = 0; L < doc.layers.length; L++) {
    var lay = doc.layers[L];
    lines.push("LAYER " + lay.name + " visible=" + lay.visible + " items=" + lay.pageItems.length + " sublayers=" + lay.layers.length);
    for (var k = 0; k < lay.pageItems.length; k++) walk(lay.pageItems[k], 1);
  }
  var f = new File(outPath); f.encoding = "UTF-8"; f.open("w"); f.write(lines.join("\n")); f.close();
  if (created) doc.close(SaveOptions.DONOTSAVECHANGES);
  return "ok " + lines.length;
})(arguments);
