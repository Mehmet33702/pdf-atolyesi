// PDF Atölyesi – Electron kabuğu (kurulumsuz / portable)
// Web uygulaması (index.html, app.js, ocr.js...) DEĞİŞTİRİLMEDEN çalışır.
// CDN adreslerine giden istekler paketin içindeki yerel kopyalara yönlendirilir,
// böylece uygulama internetsiz de çalışır (Türkçe OCR modeli dahil).
const { app, BrowserWindow, session, shell, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const NM = path.join(__dirname, 'node_modules');
const ALLOWED_NPM = new Set(['tesseract.js', 'tesseract.js-core']);
const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.gz': 'application/octet-stream'
};

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// CDN URL'sini paket içindeki dosya yoluna çevirir; eşleşme yoksa null.
function mapToLocal(u) {
  let p = null, m;
  if (u.hostname === 'cdnjs.cloudflare.com') {
    if ((m = u.pathname.match(/^\/ajax\/libs\/pdf\.js\/[^/]+\/(pdf(?:\.worker)?\.min\.js)$/)))
      p = path.join(NM, 'pdfjs-dist', 'build', m[1]);
    else if (/^\/ajax\/libs\/pdf-lib\/[^/]+\/pdf-lib\.min\.js$/.test(u.pathname))
      p = path.join(NM, 'pdf-lib', 'dist', 'pdf-lib.min.js');
  } else if (u.hostname === 'cdn.jsdelivr.net') {
    m = u.pathname.match(/^\/npm\/([^/@]+)@[^/]+\/(.+)$/);
    if (m && ALLOWED_NPM.has(m[1])) p = path.join(NM, m[1], decodeURIComponent(m[2]));
  } else if (u.hostname === 'tessdata.projectnaptha.com') {
    m = u.pathname.match(/^\/4\.0\.0\/(tur\.traineddata\.gz)$/);
    if (m) p = path.join(NM, '@tesseract.js-data', 'tur', '4.0.0', m[1]);
  }
  return p && inside(NM, p) ? p : null;
}

function setupOfflineLibs() {
  session.defaultSession.protocol.handle('https', async request => {
    try {
      const local = mapToLocal(new URL(request.url));
      if (local) {
        const buf = await fs.readFile(local);
        return new Response(buf, {
          status: 200,
          headers: {
            'Content-Type': MIME[path.extname(local)] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
            'Cross-Origin-Resource-Policy': 'cross-origin'
          }
        });
      }
    } catch (_) { /* yerelde yoksa internete düş */ }
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 600,
    backgroundColor: '#e8ebf1',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Dış bağlantıları varsayılan tarayıcıda aç, uygulama içinde başka sayfaya gitme
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [w] = BrowserWindow.getAllWindows();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    setupOfflineLibs();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
