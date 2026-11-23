'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaults(defaultOutputDir) {
  return {
    outputDir: defaultOutputDir || path.join(os.homedir(), 'Desktop', 'Alleyoop'),
    illustratorPath: null, // null = auto-discover
    launchAtLogin: false,
    lang: 'hu', // menu / notification / dialog language: 'hu' | 'en'
  };
}

// createSettings(filePath) -> { get(), set(patch), path }
// opts.defaultOutputDir: Electron passes app.getPath('desktop')/Alleyoop (OneDrive-aware).
function createSettings(filePath, opts) {
  let data = defaults(opts && opts.defaultOutputDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') data = Object.assign(data, parsed);
  } catch (e) { /* missing or corrupt -> defaults */ }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }
  return {
    path: filePath,
    get: () => Object.assign({}, data),
    set(patch) {
      data = Object.assign(data, patch);
      save();
      return Object.assign({}, data);
    },
  };
}

module.exports = { createSettings, defaults };
