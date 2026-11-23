// Minimal ZIP writer (STORE method, no compression). Dependency-free, ES2017.
// files: [{ name: string (may contain "/" and UTF-8), data: Uint8Array }]
// returns: Uint8Array containing a valid .zip archive.
function makeZip(files) {
  // CRC32 table (IEEE polynomial)
  var crcTable = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // UTF-8 encoder (lone surrogates become U+FFFD)
  function utf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xDC00 && lo <= 0xDFFF) {
          cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          i++;
        }
      }
      if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return new Uint8Array(out);
  }

  var now = new Date();
  var dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  var dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  var FLAG_UTF8 = 0x0800;
  var VERSION = 20;

  var entries = [];
  var size = 0;
  for (var i = 0; i < files.length; i++) {
    var name = utf8(files[i].name);
    var data = files[i].data;
    var entry = { name: name, data: data, crc: crc32(data), offset: 0 };
    entries.push(entry);
    size += 30 + name.length + data.length; // local file header + name + data
  }
  for (var j = 0; j < entries.length; j++) {
    size += 46 + entries[j].name.length; // central directory header + name
  }
  size += 22; // end of central directory record

  var out = new Uint8Array(size);
  var dv = new DataView(out.buffer);
  var pos = 0;

  // Local file headers + data
  for (var a = 0; a < entries.length; a++) {
    var e = entries[a];
    e.offset = pos;
    dv.setUint32(pos, 0x04034B50, true);
    dv.setUint16(pos + 4, VERSION, true);
    dv.setUint16(pos + 6, FLAG_UTF8, true);
    dv.setUint16(pos + 8, 0, true); // method: STORE
    dv.setUint16(pos + 10, dosTime, true);
    dv.setUint16(pos + 12, dosDate, true);
    dv.setUint32(pos + 14, e.crc, true);
    dv.setUint32(pos + 18, e.data.length, true);
    dv.setUint32(pos + 22, e.data.length, true);
    dv.setUint16(pos + 26, e.name.length, true);
    dv.setUint16(pos + 28, 0, true); // extra length
    pos += 30;
    out.set(e.name, pos);
    pos += e.name.length;
    out.set(e.data, pos);
    pos += e.data.length;
  }

  // Central directory
  var cdOffset = pos;
  for (var b = 0; b < entries.length; b++) {
    var f = entries[b];
    dv.setUint32(pos, 0x02014B50, true);
    dv.setUint16(pos + 4, 0x031E, true); // made by: Unix, spec 3.0
    dv.setUint16(pos + 6, VERSION, true);
    dv.setUint16(pos + 8, FLAG_UTF8, true);
    dv.setUint16(pos + 10, 0, true); // method: STORE
    dv.setUint16(pos + 12, dosTime, true);
    dv.setUint16(pos + 14, dosDate, true);
    dv.setUint32(pos + 16, f.crc, true);
    dv.setUint32(pos + 20, f.data.length, true);
    dv.setUint32(pos + 24, f.data.length, true);
    dv.setUint16(pos + 28, f.name.length, true);
    dv.setUint16(pos + 30, 0, true); // extra length
    dv.setUint16(pos + 32, 0, true); // comment length
    dv.setUint16(pos + 34, 0, true); // disk number start
    dv.setUint16(pos + 36, 0, true); // internal attributes
    dv.setUint32(pos + 38, 0x81A40000, true); // external attributes: regular file, 0644
    dv.setUint32(pos + 42, f.offset, true);
    pos += 46;
    out.set(f.name, pos);
    pos += f.name.length;
  }
  var cdSize = pos - cdOffset;

  // End of central directory
  dv.setUint32(pos, 0x06054B50, true);
  dv.setUint16(pos + 4, 0, true); // this disk
  dv.setUint16(pos + 6, 0, true); // disk with central directory
  dv.setUint16(pos + 8, entries.length, true);
  dv.setUint16(pos + 10, entries.length, true);
  dv.setUint32(pos + 12, cdSize, true);
  dv.setUint32(pos + 16, cdOffset, true);
  dv.setUint16(pos + 20, 0, true); // comment length

  return out;
}

if (typeof module !== "undefined") module.exports = { makeZip };
