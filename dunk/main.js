'use strict';
const path = require('path');
const fs = require('fs');
const { app, Tray, Menu, nativeImage, dialog, shell, Notification, BrowserWindow } = require('electron');
const { createSettings } = require('./src/settings');
const { createQueue } = require('./src/queue');
const { createServer } = require('./src/server');
const illustrator = require('./src/illustrator');
const { t } = require('./src/i18n');
const { cleanupOld } = require('./src/batches');
const { createLogger } = require('./src/logger');

// Renamed Json MAClane -> Dunk (CONTRACT §12): userData moved with productName, so carry settings over once.
try {
  const oldSettings = path.join(app.getPath('appData'), 'Json MAClane', 'settings.json');
  const newSettings = path.join(app.getPath('userData'), 'settings.json');
  if (!fs.existsSync(newSettings) && fs.existsSync(oldSettings)) {
    fs.mkdirSync(path.dirname(newSettings), { recursive: true });
    fs.copyFileSync(oldSettings, newSettings);
  }
} catch (e) { /* no old settings -> defaults */ }

// File log in <userData>/logs/json-maclane.log (5 MB, 3 rotated copies); also echoed to the console.
const log = createLogger({ dir: path.join(app.getPath('userData'), 'logs') });
process.on('uncaughtException', (e) => log('uncaughtException: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => log('unhandledRejection: ' + (e && e.stack || e)));
if (process.platform === 'win32') app.setAppUserModelId('hu.tibu.jsonmaclane');

if (!app.requestSingleInstanceLock()) app.quit();

let tray = null;
let settings, queue, server;
let working = null; // frame name currently converting
const recent = []; // [{name, aiPath}] newest first, max 10

const jsxPath = app.isPackaged
  ? path.join(process.resourcesPath, 'build-ai.jsx')
  : path.join(__dirname, 'src', 'build-ai.jsx');

const resolveIllustrator = () => settings.get().illustratorPath || illustrator.discover();

function trayImage() {
  const dir = path.join(__dirname, 'assets');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  if (process.platform === 'win32') {
    const ico = path.join(dir, 'tray.ico');
    if (fs.existsSync(ico)) return nativeImage.createFromPath(ico); // multi-size .ico, no resize
  }
  return nativeImage.createFromPath(path.join(dir, 'tray.png')).resize({ width: 16, height: 16 });
}

const L = () => settings.get().lang;
const tr = (k, ...a) => t(L(), k, ...a);

function statusLine() {
  if (!resolveIllustrator()) return tr('menu.status.noAi');
  if (working) return tr('menu.status.working', working);
  return tr('menu.status.running', queue.length());
}

async function pickFolder({ title, defaultPath }) {
  fs.mkdirSync(defaultPath, { recursive: true });
  const opts = { title, message: title, defaultPath, properties: ['openDirectory', 'createDirectory'] };
  if (process.platform === 'darwin') {
    app.focus({ steal: true });
    const r = await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  }
  // Windows: focus-stealing prevention can hide the dialog behind Figma, so give it a hidden always-on-top parent.
  let parent = null;
  try {
    parent = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, alwaysOnTop: true });
    parent.setAlwaysOnTop(true, 'screen-saver');
    parent.focus();
    app.focus();
    const r = await dialog.showOpenDialog(parent, opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  } finally {
    if (parent && !parent.isDestroyed()) parent.destroy();
  }
}

async function runDiagnostics() {
  try {
    const file = await illustrator.diagnose({
      appPath: resolveIllustrator() || undefined, jsxPath, log, lang: L(),
      logDir: log.dir, settingsPath: settings.get().illustratorPath,
    });
    log('diagnostics written: ' + file);
    shell.openPath(file);
  } catch (e) {
    log('diagnostics failed: ' + (e && e.stack || e));
  }
}

function rebuildMenu() {
  if (!tray) return;
  const s = settings.get();
  const ai = resolveIllustrator();
  const recentItems = recent.length
    ? recent.map((r) => ({ label: r.name, click: () => shell.showItemInFolder(r.aiPath) }))
    : [{ label: tr('menu.recent.none'), enabled: false }];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLine(), enabled: false },
    { type: 'separator' },
    { label: tr('menu.recent'), submenu: recentItems },
    { label: tr('menu.openOut'), click: () => { fs.mkdirSync(s.outputDir, { recursive: true }); shell.openPath(s.outputDir); } },
    { label: tr('menu.changeOut'), click: async () => {
      const r = await dialog.showOpenDialog({ title: tr('dlg.outTitle'), defaultPath: s.outputDir, properties: ['openDirectory', 'createDirectory'] });
      if (!r.canceled && r.filePaths[0]) { settings.set({ outputDir: r.filePaths[0] }); rebuildMenu(); }
    } },
    { type: 'separator' },
    { label: tr('menu.aiLabel', ai || tr('menu.aiNone')), enabled: false },
    { label: tr('menu.aiPick'), click: async () => {
      const isMac = process.platform === 'darwin';
      const r = await dialog.showOpenDialog({
        title: tr('dlg.aiTitle'),
        defaultPath: isMac ? '/Applications' : process.env['ProgramFiles'],
        properties: ['openFile'],
        filters: isMac ? [{ name: tr('dlg.appFilter'), extensions: ['app'] }] : [{ name: 'Illustrator.exe', extensions: ['exe'] }],
      });
      if (!r.canceled && r.filePaths[0]) { settings.set({ illustratorPath: r.filePaths[0] }); rebuildMenu(); }
    } },
    { type: 'separator' },
    { label: tr('menu.login'), type: 'checkbox', checked: !!s.launchAtLogin, click: (item) => {
      settings.set({ launchAtLogin: item.checked });
      app.setLoginItemSettings({ openAtLogin: item.checked });
    } },
    { label: tr('menu.openLogs'), click: () => { fs.mkdirSync(log.dir, { recursive: true }); shell.openPath(log.dir); } },
    { label: tr('menu.diag'), click: () => runDiagnostics() },
    { label: tr('menu.lang'), submenu: [
      { label: 'Magyar', type: 'radio', checked: L() === 'hu', click: () => { settings.set({ lang: 'hu' }); rebuildMenu(); } },
      { label: 'English', type: 'radio', checked: L() === 'en', click: () => { settings.set({ lang: 'en' }); rebuildMenu(); } },
    ] },
    { type: 'separator' },
    { label: tr('menu.quit'), click: () => app.quit() },
  ]));
}

app.on('second-instance', () => rebuildMenu());

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  settings = createSettings(path.join(app.getPath('userData'), 'settings.json'),
    { defaultOutputDir: path.join(app.getPath('desktop'), 'Alleyoop') });
  log('Dunk ' + app.getVersion() + ' starting; log: ' + log.file);
  app.setLoginItemSettings({ openAtLogin: !!settings.get().launchAtLogin });

  cleanupOld();
  queue = createQueue({
    getSettings: settings.get,
    resolveIllustrator,
    runJsx: illustrator.runJsx,
    jsxPath,
    log,
    getLogPath: () => log.file,
  });
  queue.on('job-start', (e) => { working = e.frameName; log('job-start ' + e.frameName); rebuildMenu(); });
  queue.on('job-done', (e) => {
    working = null;
    recent.unshift({ name: e.frameName, aiPath: e.aiPath });
    recent.length = Math.min(recent.length, 10);
    log('job-done ' + e.aiPath);
    rebuildMenu();
  });
  queue.on('job-failed', (e) => {
    working = null;
    log('job-failed ' + e.frameName + ' [' + e.code + '] ' + e.message);
    if (Notification.isSupported()) new Notification({ title: tr('notif.title'), body: e.frameName + ': ' + e.message }).show();
    rebuildMenu();
  });

  tray = new Tray(trayImage());
  tray.setToolTip('Dunk');
  if (process.platform === 'win32') tray.on('click', () => tray.popUpContextMenu());
  rebuildMenu();

  server = createServer({
    settings, log,
    runJob: (p) => queue.enqueue(p),
    pickFolder,
    getLang: L,
    getLogPath: () => log.file,
    getIllustrator: resolveIllustrator,
    getQueueLength: () => queue.length(),
  });
  try {
    await server.start();
  } catch (e) {
    log('server start failed: ' + (e && e.code) + ' ' + (e && e.message));
    dialog.showErrorBox('Dunk',
      e && e.code === 'EADDRINUSE' ? tr('dlg.portBusy')
        : e && e.code === 'EACCES' ? tr('dlg.portDenied')
        : tr('dlg.serverFail', e && e.message));
    app.quit();
  }
});

// Tray-only app: keep running with no windows.
app.on('window-all-closed', () => {});
