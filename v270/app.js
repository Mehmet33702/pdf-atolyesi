/* ---------- Genel Durum ve Yardımcılar ---------- */
const $ = s => document.querySelector(s);
const isMobile = () => window.innerWidth <= 768;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const S = {
  bytes: null,
  doc: null,
  name: 'belge.pdf',
  fileHandle: null,
  pgs: [],
  zoom: 1.2,
  tool: 'select',
  hist: [],
  closeEditor: null,
  activeOcrPg: null
};

let io = null;
let toastTimer = null;
let scrollOcrTimer = null;

function toast(msg, isErr = false) {
  const t = $('#toast');
  const h = $('header');
  if (h) t.style.top = (Math.max(0, h.getBoundingClientRect().bottom) + 8) + 'px';
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

const rotOf = pg => (pg.base + pg.rot) % 360;
const toRaw = (R, u, v) => R === 90 ? [v, 1 - u] : R === 180 ? [1 - u, 1 - v] : R === 270 ? [1 - v, u] : [u, v];
const fromRaw = (R, x, y) => R === 90 ? [1 - y, x] : R === 180 ? [1 - x, 1 - y] : R === 270 ? [y, 1 - x] : [x, y];
const paintAll = () => S.pgs.forEach(paint);

function calcFitZoom() {
  if (!S.pgs.length) return 1.2;
  const pg = S.pgs[0], R = rotOf(pg), pw = R % 180 ? pg.h : pg.w;
  const avail = Math.max(260, window.innerWidth - (isMobile() ? 18 : 48));
  return Math.min(isMobile() ? 1.4 : 1.3, Math.max(0.35, +(avail / pw).toFixed(2)));
}

/* ---------- Vektör PDF Metni İçin Unicode Font Yönetimi ---------- */
const PDF_FONT_BASE = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';
const PDF_FONT_FILES = {
  sans:  { r: 'DejaVuSans.ttf',     b: 'DejaVuSans-Bold.ttf',     i: 'DejaVuSans-Oblique.ttf',     bi: 'DejaVuSans-BoldOblique.ttf' },
  serif: { r: 'DejaVuSerif.ttf',    b: 'DejaVuSerif-Bold.ttf',    i: 'DejaVuSerif-Italic.ttf',     bi: 'DejaVuSerif-BoldItalic.ttf' },
  mono:  { r: 'DejaVuSansMono.ttf', b: 'DejaVuSansMono-Bold.ttf', i: 'DejaVuSansMono-Oblique.ttf', bi: 'DejaVuSansMono-BoldOblique.ttf' }
};
const pdfFontByteCache = new Map();

function pickPdfFontKey(s) {
  const css = String(s.font || '').toLowerCase();
  const generic = (css.split(',').pop() || '').replace(/["']/g, '').trim();
  const fam = generic === 'monospace' ? 'mono' : generic === 'serif' ? 'serif' : 'sans';
  const style = (s.bold && s.italic) ? 'bi' : s.bold ? 'b' : s.italic ? 'i' : 'r';
  return `${fam}:${style}`;
}

async function getFallbackPdfFont(pdfDoc, embeddedMap, key) {
  if (embeddedMap.has(key)) return embeddedMap.get(key);
  const [fam, style] = key.split(':');
  const file = PDF_FONT_FILES[fam][style];

  let bytes = pdfFontByteCache.get(file);
  if (!bytes) {
    const res = await fetch(PDF_FONT_BASE + file);
    if (!res.ok) throw new Error('Font indirilemedi: ' + file);
    bytes = new Uint8Array(await res.arrayBuffer());
    pdfFontByteCache.set(file, bytes);
  }
  const font = await pdfDoc.embedFont(bytes, { subset: true });
  embeddedMap.set(key, font);
  return font;
}

async function getEmbeddedPdfFont(pdfDoc, embeddedMap, s) {
  if (typeof getLocalFontBytes === 'function' && typeof primaryFamily === 'function') {
    const fam = primaryFamily(s.font);
    const lk = `local:${fam}:${s.bold ? 'b' : ''}${s.italic ? 'i' : ''}`;
    try {
      let f = embeddedMap.get(lk);
      if (!f) {
        const bytes = await getLocalFontBytes(fam, !!s.bold, !!s.italic);
        if (bytes) {
          f = await pdfDoc.embedFont(bytes, { subset: true });
          embeddedMap.set(lk, f);
        }
      }
      if (f) {
        const set = new Set(f.getCharacterSet());
        const ok = [...String(s.s || '')].every(ch => /\s/.test(ch) || set.has(ch.codePointAt(0)));
        if (ok) return f;
      }
    } catch (e) {
      console.warn('Yerel font gömülemedi, yedek font kullanılacak:', e);
    }
  }
  return getFallbackPdfFont(pdfDoc, embeddedMap, pickPdfFontKey(s));
}

function wrapPdfLines(font, text, size, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    if (!maxW || !para.trim()) {
      out.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const part of words) {
      const test = line + part;
      if (line && font.widthOfTextAtSize(test, size) > maxW) {
        out.push(line.trimEnd());
        line = part.trimStart();
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

/* ---------- Ekranda Ağırlıklı Olan Aktif Sayfayı Yönetme ---------- */
function getMostVisiblePage() {
  const sheets = document.querySelectorAll('.sheet');
  const h = $('header');
  const topBound = h ? h.getBoundingClientRect().bottom : 0;
  const botBound = window.innerHeight;
  let bestPg = null, maxVis = 0;

  sheets.forEach(sh => {
    const r = sh.getBoundingClientRect();
    const vis = Math.max(0, Math.min(r.bottom, botBound) - Math.max(r.top, topBound));
    if (vis > maxVis) {
      maxVis = vis;
      bestPg = sh._pg;
    }
  });
  return bestPg;
}

function updateActiveOcrPage() {
  if (S.tool !== 'ocr') {
    if (S.activeOcrPg) {
      const prev = S.activeOcrPg;
      S.activeOcrPg = null;
      prev.hoverBox = null;
      paint(prev);
    }
    return;
  }

  const bestPg = getMostVisiblePage();
  if (!bestPg || bestPg === S.activeOcrPg) return;

  if (S.closeEditor) S.closeEditor(false);
  const prevPg = S.activeOcrPg;
  S.activeOcrPg = bestPg;

  if (prevPg) {
    prevPg.hoverBox = null;
    paint(prevPg);
  }

  paint(bestPg);
  if (bestPg.baseCanvas) ensureOcrCache(bestPg);
}

window.addEventListener('scroll', () => {
  if (S.tool !== 'ocr') return;
  clearTimeout(scrollOcrTimer);
  scrollOcrTimer = setTimeout(updateActiveOcrPage, 220);
}, { passive: true });

/* ---------- PDF Yükleme ve Sayfa Oluşturma ---------- */
async function load(bytes, name, fileHandle = null) {
  try {
    if (S.closeEditor) S.closeEditor(true);
    if (S.doc) { try { await S.doc.destroy(); } catch (_) {} }

    const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    S.bytes = bytes;
    S.doc = doc;
    S.name = name || 'belge.pdf';
    S.fileHandle = fileHandle;
    S.hist = [];
    S.pgs = [];
    S.activeOcrPg = null;

    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i);
      const v = p.getViewport({ scale: 1, rotation: 0 });
      S.pgs.push({
        n: i, rot: 0, base: p.rotate,
        w: v.width, h: v.height,
        shapes: [], preview: [], editingHide: null,
        ocrCache: null, ocrLoading: false, hoverBox: null
      });
    }

    S.zoom = calcFitZoom();
    $('#empty').hidden = true;
    $('#save').disabled = false;
    $('#saveAs').disabled = false;
    $('#print').disabled = false;
    $('#btnEdit').disabled = false;
    build();
  } catch (e) {
    toast('Bu PDF açılamadı. Parola korumalı ya da bozuk olabilir.', true);
  }
}

function build() {
  if (S.closeEditor) S.closeEditor(true);
  S.activeOcrPg = null;
  const box = $('#pages');
  box.innerHTML = '';
  if (io) io.disconnect();

  io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        io.unobserve(e.target);
        draw(e.target._pg, e.target);
      }
    });
  }, { rootMargin: '600px' });

  S.pgs.forEach((pg, i) => {
    const R = rotOf(pg);
    const sw = (R % 180 ? pg.h : pg.w) * S.zoom;
    const sh = (R % 180 ? pg.w : pg.h) * S.zoom;

    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = sw + 'px';

    const lbl = document.createElement('span');
    lbl.textContent = `Sayfa ${i + 1} / ${S.pgs.length}`;
    bar.appendChild(lbl);

    [['Döndür', () => rotate(pg)], ['Sil', () => del(i)], ['↑', () => move(i, -1)], ['↓', () => move(i, 1)]]
      .forEach(([label, fn], k) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = fn;
        if (k === 2) b.setAttribute('aria-label', 'Yukarı taşı');
        if (k === 3) b.setAttribute('aria-label', 'Aşağı taşı');
        bar.appendChild(b);
      });

    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.style.width = sw + 'px';
    sheet.style.height = sh + 'px';
    sheet._pg = pg;

    box.append(bar, sheet);
    io.observe(sheet);
  });

  setTool(S.tool, true);
  upd();
}

async function draw(pg, sheet) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const R = rotOf(pg);
  const page = await S.doc.getPage(pg.n);
  const vp = page.getViewport({ scale: S.zoom * dpr, rotation: R });

  const c = document.createElement('canvas');
  c.width = vp.width;
  c.height = vp.height;

  const ov = document.createElement('canvas');
  ov.className = 'ov';
  ov.width = vp.width;
  ov.height = vp.height;

  sheet.append(c, ov);
  pg.ov = ov;
  pg.baseCanvas = c;

  bind(ov, pg);
  paint(pg);
  setTool(S.tool, true);

  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  if (S.tool === 'ocr') {
    if (!S.activeOcrPg) updateActiveOcrPage();
    else if (S.activeOcrPg === pg) ensureOcrCache(pg);
  }
}

/* ---------- Paragraf Yerleşimi (iki yana yaslama, girinti) ---------- */
function layoutParagraphText(text, maxW, indent, measure) {
  const out = [];
  let firstPara = true;
  for (const para of String(text).split('\n')) {
    const ind0 = firstPara ? (indent || 0) : 0;
    if (!para.trim()) { out.push({ s: '', last: true, ind: 0 }); continue; }
    firstPara = false;
    if (!maxW) { out.push({ s: para, last: true, ind: ind0 }); continue; }
    let first = true, line = '';
    for (const part of para.split(/(\s+)/)) {
      const test = line + part;
      const avail = Math.max(10, maxW - (first ? ind0 : 0));
      if (line && measure(test) > avail) {
        out.push({ s: line.trimEnd(), last: false, ind: first ? ind0 : 0 });
        first = false;
        line = part.trimStart();
      } else {
        line = test;
      }
    }
    out.push({ s: line, last: true, ind: first ? ind0 : 0 });
  }
  return out;
}

function drawAlignedLine(ctx, ln, x, y, maxW, align) {
  if (!ln.s) return;
  if (!maxW || align === 'left') { ctx.fillText(ln.s, x + ln.ind, y); return; }
  const w = ctx.measureText(ln.s).width;
  if (align === 'center') { ctx.fillText(ln.s, x + (maxW - w) / 2, y); return; }
  if (align === 'right') { ctx.fillText(ln.s, x + maxW - w, y); return; }
  if (align === 'justify' && !ln.last) {
    const ws = ln.s.split(/\s+/).filter(Boolean);
    if (ws.length > 1) {
      const total = ws.reduce((t, k) => t + ctx.measureText(k).width, 0);
      const gap = Math.max(0, (maxW - ln.ind - total) / (ws.length - 1));
      let cx = x + ln.ind;
      ws.forEach(k => { ctx.fillText(k, cx, y); cx += ctx.measureText(k).width + gap; });
      return;
    }
  }
  ctx.fillText(ln.s, x + ln.ind, y);
}

function shapes(ctx, list, W, H) {
  const lw = W * 0.003;
  for (const s of list) {
    ctx.save();
    ctx.lineWidth = lw;
    ctx.lineCap = ctx.lineJoin = 'round';

    if (s.t === 'hl') {
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#ffd60a';
      ctx.fillRect(s.x * W, s.y * H, s.w * W, s.h * H);
    } else if (s.t === 'white') {
      ctx.fillStyle = s.c || '#fff';
      ctx.fillRect(s.x * W, s.y * H, s.w * W, s.h * H);
    } else if (s.t === 'patch' && s.canvas) {
      ctx.drawImage(s.canvas, s.x * W, s.y * H, s.w * W, s.h * H);
    } else if (s.t === 'rect') {
      ctx.strokeStyle = s.c;
      ctx.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H);
    } else if (s.t === 'sel') {
      ctx.fillStyle = 'rgba(42,91,215,0.12)';
      ctx.fillRect(s.x * W, s.y * H, s.w * W, s.h * H);
      ctx.strokeStyle = '#2a5bd7';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H);
    } else if (s.t === 'pen') {
      ctx.strokeStyle = s.c;
      ctx.beginPath();
      s.p.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
      ctx.stroke();
    } else if (s.t === 'text') {
      ctx.fillStyle = s.c;
      ctx.textBaseline = 'top';
      const style = (s.italic ? 'italic ' : '') + (s.bold ? '700 ' : '400 ');
      const px = s.size * W;
      const family = s.font || 'Arial, Helvetica, sans-serif';
      ctx.font = `${style}${px}px ${family}`;
      const lh = px * (s.lh || 1.25);
      const lead = ((s.lh || 1.25) - 1.25) * px / 2;
      const maxWpx = s.maxW ? s.maxW * W : 0;
      const lines = maxWpx
        ? layoutParagraphText(s.s, maxWpx, (s.indent || 0) * W, t => ctx.measureText(t).width)
        : s.s.split('\n').map(t => ({ s: t, last: true, ind: 0 }));
      lines.forEach((ln, i) => drawAlignedLine(ctx, ln, s.x * W, s.y * H + lead + i * lh, maxWpx, s.align || 'left'));
    }
    ctx.restore();
  }
}

function paint(pg) {
  const ov = pg.ov;
  if (!ov) return;
  const ctx = ov.getContext('2d');
  const R = rotOf(pg);
  const cw = ov.width, ch = ov.height;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (R === 90) { ctx.translate(cw, 0); ctx.rotate(Math.PI / 2); }
  else if (R === 180) { ctx.translate(cw, ch); ctx.rotate(Math.PI); }
  else if (R === 270) { ctx.translate(0, ch); ctx.rotate(-Math.PI / 2); }

  const W = R % 180 ? ch : cw;
  const H = R % 180 ? cw : ch;

  const visibleShapes = pg.editingHide
    ? pg.shapes.filter(s => !pg.editingHide.includes(s))
    : pg.shapes;
  shapes(ctx, visibleShapes, W, H);

  if (S.tool === 'ocr' && S.activeOcrPg === pg && pg.ocrCache) {
    ctx.save();
    const pxLine = Math.max(1, W / 900);
    for (const seg of pg.ocrCache) {
      const isHover = pg.hoverBox === seg;
      const x = seg.x * W, y = seg.y * H, w = seg.w * W, h = seg.h * H;
      if (isHover) {
        ctx.fillStyle = 'rgba(42,91,215,0.06)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#2a5bd7';
        ctx.lineWidth = pxLine * 1.6;
      } else {
        ctx.strokeStyle = 'rgba(115,128,148,0.5)';
        ctx.lineWidth = pxLine;
      }
      ctx.strokeRect(x, y, w, h);
    }
    ctx.restore();
  }

  if (pg.preview && pg.preview.length) shapes(ctx, pg.preview, W, H);
}

/* ---------- Etkileşim ve Araçlar ---------- */
function bind(ov, pg) {
  let dragging = false;

  ov.addEventListener('pointermove', e => {
    if (S.tool !== 'ocr' || S.activeOcrPg !== pg || dragging || e.pointerType === 'touch') return;
    const r = ov.getBoundingClientRect(), R = rotOf(pg);
    const [x, y] = toRaw(R, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    const hit = hitTestOcr(pg, x, y);
    if (hit !== pg.hoverBox) {
      pg.hoverBox = hit;
      ov.style.cursor = hit ? 'text' : 'crosshair';
      paint(pg);
    }
  });

  ov.addEventListener('pointerleave', () => {
    if (pg.hoverBox) { pg.hoverBox = null; paint(pg); }
  });

  ov.addEventListener('pointerdown', e => {
    const t = S.tool;
    if (t === 'select') return;
    e.preventDefault();
    const r = ov.getBoundingClientRect(), R = rotOf(pg);
    const P = ev => toRaw(R, (ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height);
    const [x0, y0] = P(e);

    if (t === 'ocr') {
      if (S.closeEditor) S.closeEditor(false);

      if (S.activeOcrPg !== pg) {
        const prev = S.activeOcrPg;
        S.activeOcrPg = pg;
        if (prev) { prev.hoverBox = null; paint(prev); }
      }

      dragging = true;
      const sel = { t: 'sel', x: x0, y: y0, w: 0, h: 0 };
      pg.preview = [sel];
      ov.setPointerCapture(e.pointerId);

      const mv = ev => {
        const [x, y] = P(ev);
        sel.x = Math.min(x0, x); sel.y = Math.min(y0, y);
        sel.w = Math.abs(x - x0); sel.h = Math.abs(y - y0);
        paint(pg);
      };
      const up = () => {
        dragging = false;
        ov.removeEventListener('pointermove', mv);
        ov.removeEventListener('pointerup', up);
        ov.removeEventListener('pointercancel', up);
        pg.preview = [];
        paint(pg);

        if (sel.w > 0.015 && sel.h > 0.01) {
          ocrRegionEdit(pg, sel, R);
        } else {
          const hit = hitTestOcr(pg, x0, y0);
          if (hit) openFloatingOcrEditor(pg, hit, R);
          else ensureOcrCache(pg).then(() => {
            const h2 = hitTestOcr(pg, x0, y0);
            if (h2) openFloatingOcrEditor(pg, h2, R);
            else toast('Burada metin bloğu yok. Parmağınızla/fareyle kutu çizin.');
          });
        }
      };

      ov.addEventListener('pointermove', mv);
      ov.addEventListener('pointerup', up);
      ov.addEventListener('pointercancel', up);
      return;
    }

    const c = $('#color').value;
    if (t === 'text') return addText(ov, pg, e, x0, y0, c);

    const curColor = t === 'white' ? $('#bgColor').value : c;
    const cur = t === 'pen' ? { t, c: curColor, p: [[x0, y0]] } : { t, c: curColor, x: x0, y: y0, w: 0, h: 0 };
    pg.shapes.push(cur);
    ov.setPointerCapture(e.pointerId);

    const mv = ev => {
      const [x, y] = P(ev);
      if (t === 'pen') cur.p.push([x, y]);
      else {
        cur.x = Math.min(x0, x); cur.y = Math.min(y0, y);
        cur.w = Math.abs(x - x0); cur.h = Math.abs(y - y0);
      }
      paint(pg);
    };
    const up = () => {
      ov.removeEventListener('pointermove', mv);
      ov.removeEventListener('pointerup', up);
      ov.removeEventListener('pointercancel', up);
      const tiny = t === 'pen' ? cur.p.length < 2 : cur.w < 0.004 || cur.h < 0.004;
      if (tiny) pg.shapes.pop();
      else push(() => pg.shapes.splice(pg.shapes.indexOf(cur), 1));
      paint(pg);
    };

    ov.addEventListener('pointermove', mv);
    ov.addEventListener('pointerup', up);
    ov.addEventListener('pointercancel', up);
  });
}

function addText(ov, pg, e, x, y, c) {
  const sh = ov.parentElement, r = ov.getBoundingClientRect(), R = rotOf(pg), size = 0.022;
  const rw = R % 180 ? r.height : r.width;
  const inp = document.createElement('input');
  inp.className = 'ti';
  inp.style.left = Math.min(r.width - 130, Math.max(4, e.clientX - r.left)) + 'px';
  inp.style.top = (e.clientY - r.top) + 'px';
  inp.style.fontSize = (size * rw) + 'px';
  inp.style.color = c;
  sh.appendChild(inp);
  setTimeout(() => inp.focus(), 0);

  let done = false;
  const fin = () => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    inp.remove();
    if (v) {
      const s = { t: 'text', c, x, y, s: v, size };
      pg.shapes.push(s);
      push(() => pg.shapes.splice(pg.shapes.indexOf(s), 1));
      paint(pg);
    }
  };
  inp.onblur = fin;
  inp.onkeydown = ev => {
    if (ev.key === 'Enter') inp.blur();
    if (ev.key === 'Escape') { inp.value = ''; inp.blur(); }
  };
}

/* ---------- Geçmiş, Sayfa İşlemleri ve Araç Çubuğu ---------- */
function push(f, full) { S.hist.push({ f, full }); upd(); }
function upd() { $('#undo').disabled = !S.hist.length; }
function undo() {
  const h = S.hist.pop();
  if (!h) return;
  h.f();
  h.full ? build() : paintAll();
  upd();
}

$('#undo').onclick = undo;
addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.matches('input,textarea')) {
    e.preventDefault();
    undo();
  }
});

function rotate(pg) {
  pg.rot = (pg.rot + 90) % 360;
  push(() => { pg.rot = (pg.rot + 270) % 360; }, true);
  build();
}

function del(i) {
  if (S.pgs.length < 2) return toast('Son sayfa silinemez.', true);
  const [pg] = S.pgs.splice(i, 1);
  push(() => S.pgs.splice(i, 0, pg), true);
  build();
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.pgs.length) return;
  const sw = () => { [S.pgs[i], S.pgs[j]] = [S.pgs[j], S.pgs[i]]; };
  sw();
  push(sw, true);
  build();
}

function setTool(t, silent) {
  S.tool = t;
  if (t !== 'ocr') {
    if (S.closeEditor) S.closeEditor(false);
    S.activeOcrPg = null;
  }
  document.querySelectorAll('#tools [data-t], #btnEdit').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === t));
  document.querySelectorAll('.ov').forEach(o => {
    o.classList.toggle('off', t === 'select');
    o.classList.toggle('on', t !== 'select');
    if (t !== 'ocr') o.style.cursor = '';
  });
  paintAll();
  if (t === 'ocr' && !silent) {
    updateActiveOcrPage();
  }
}

$('#tools').addEventListener('click', e => {
  const b = e.target.closest('[data-t]');
  if (b && !b.disabled) setTool(b.dataset.t);
});
$('#btnEdit').onclick = () => setTool(S.tool === 'ocr' ? 'select' : 'ocr');

function zoom(d) {
  S.zoom = Math.min(3, Math.max(0.35, +(S.zoom + d).toFixed(2)));
  if (S.doc) build();
}
$('#zi').onclick = () => zoom(0.2);
$('#zo').onclick = () => zoom(-0.2);
$('#zfit').onclick = () => { if (!S.doc) return; S.zoom = calcFitZoom(); build(); };

/* ---------- Kaydet (Üzerine Yaz) ve Farklı Kaydet ---------- */
function triggerDownload(data, fname) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function maskOriginalTextInBox(page, bboxNorm) {
  const {
    PDFName, PDFDict, PDFArray, PDFRawStream,
    decodePDFRawStream, PDFContentStream, PDFOperator, PDFNumber
  } = PDFLib;

  const contents = page.node.Contents();
  if (!contents) return;

  let refs = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) refs.push(contents.get(i));
  } else {
    refs.push(contents);
  }

  const parts = [];
  for (const r of refs) {
    const s = r.lookup ? r.lookup() : r;
    if (s instanceof PDFRawStream) parts.push(decodePDFRawStream(s).decode());
  }
  if (!parts.length) return;
  const total = parts.reduce((a, b) => a + b.length, 0);
  const decoded = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { decoded.set(p, off); off += p.length; }

  let tokens;
  try { tokens = PDFContentStream.parse(decoded); }
  catch (_) { return; }

  const mb = page.getMediaBox();
  const tx0 = mb.x + bboxNorm.x * mb.width;
  const tx1 = mb.x + (bboxNorm.x + bboxNorm.w) * mb.width;
  const ty1 = mb.y + mb.height - bboxNorm.y * mb.height;
  const ty0 = mb.y + mb.height - (bboxNorm.y + bboxNorm.h) * mb.height;

  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  const out = [];

  const applyTranslate = (m, tx, ty) => {
    m[4] += tx * m[0] + ty * m[2];
    m[5] += tx * m[1] + ty * m[3];
  };

  const inBox = () => {
    const x = tm[4], y = tm[5];
    return x >= tx0 - 3 && x <= tx1 + 3 && y >= ty0 - 3 && y <= ty1 + 3;
  };

  for (const tok of tokens) {
    if (!(tok instanceof PDFOperator)) {
      out.push(tok);
      continue;
    }
    const name = tok.getOperator();
    const ops = tok.operands();

    if (name === 'BT') {
      tm = [1, 0, 0, 1, 0, 0]; tlm = [...tm]; out.push(tok); continue;
    }
    if (name === 'Tm') {
      const a = ops.slice(0, 6).map(n => n.asNumber ? n.asNumber() : Number(n));
      tm = a; tlm = [...a]; out.push(tok); continue;
    }
    if (name === 'Td' || name === 'TD') {
      const [tx, ty] = ops.map(n => n.asNumber());
      applyTranslate(tlm, tx, ty);
      tm = [...tlm];
      if (name === 'TD') leading = -ty;
      out.push(tok); continue;
    }
    if (name === 'T*') {
      applyTranslate(tlm, 0, -leading);
      tm = [...tlm];
      out.push(tok); continue;
    }
    if (name === 'TL') {
      leading = ops[0].asNumber(); out.push(tok); continue;
    }

    if (name === 'Tj' || name === 'TJ' || name === "'" || name === '"') {
      if (inBox()) {
        out.push(PDFOperator.of(PDFContentStream.operators.q, []));
        out.push(PDFOperator.of(PDFContentStream.operators.Tr, [PDFNumber.of(3)]));
        out.push(tok);
        out.push(PDFOperator.of(PDFContentStream.operators.Q, []));
      } else {
        out.push(tok);
      }
      continue;
    }

    out.push(tok);
  }

  const newStream = PDFContentStream.of(PDFDict.from({}), out);
  page.node.set(PDFName.of('Contents'), page.doc.context.register(newStream));
}

/* ---------- Ortak PDF Üretimi ---------- */
async function buildPdfBytes() {
  const { PDFDocument, degrees, rgb } = PDFLib;

  const hexToRgb = h => {
    const n = parseInt((h || '#ffffff').slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const src = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const canVectorText = typeof fontkit !== 'undefined';
  if (canVectorText) out.registerFontkit(fontkit);

  const embeddedFonts = new Map();
  const cps = await out.copyPages(src, S.pgs.map(p => p.n - 1));

  for (let i = 0; i < S.pgs.length; i++) {
    const pg = S.pgs[i], p = cps[i];
    out.addPage(p);
    p.setRotation(degrees(rotOf(pg)));

    if (!pg.shapes.length) continue;
    const mb = p.getMediaBox();

    // 1) Kapatılan bölgelerdeki eski metni kopyalama/aramadan gizle
    try {
      for (const s of pg.shapes) {
        if (s.t === 'white' || s.t === 'patch') {
          await maskOriginalTextInBox(p, { x: s.x, y: s.y, w: s.w, h: s.h });
        }
      }
    } catch (e) {
      console.warn('Orijinal metin maskelenemedi:', e);
    }

    // 2) Beyaz kutular ve filigran koruyan yamaları (metinden önce) çiz
    for (const s of pg.shapes) {
      if (s.t === 'white') {
        const rw = s.w * mb.width, rh = s.h * mb.height;
        p.drawRectangle({
          x: mb.x + s.x * mb.width,
          y: mb.y + mb.height - (s.y * mb.height) - rh,
          width: rw,
          height: rh,
          color: hexToRgb(s.c),
          borderWidth: 0
        });
      } else if (s.t === 'patch' && s.canvas) {
        const rw = s.w * mb.width, rh = s.h * mb.height;
        const blob = await new Promise(r => s.canvas.toBlob(r, 'image/png'));
        const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
        p.drawImage(img, {
          x: mb.x + s.x * mb.width,
          y: mb.y + mb.height - (s.y * mb.height) - rh,
          width: rw,
          height: rh
        });
      }
    }

    // 3) Yeni metinleri vektör olarak yaz
    const fallbackRaster = [];
    for (const s of pg.shapes) {
      if (s.t === 'white' || s.t === 'patch') continue;
      if (s.t === 'text' && canVectorText) {
        try {
          const font = await getEmbeddedPdfFont(out, embeddedFonts, s);
          const fontSize = s.size * mb.width;
          const lh = fontSize * (s.lh || 1.25);
          const lead = ((s.lh || 1.25) - 1.25) * fontSize / 2;
          const ascent = font.heightAtSize(fontSize, { descender: false });
          const color = hexToRgb(s.c || '#111111');
          const x = mb.x + s.x * mb.width;
          const topY = mb.y + mb.height - (s.y * mb.height);
          const maxWpt = s.maxW ? s.maxW * mb.width : 0;
          const widthOf = t => font.widthOfTextAtSize(t, fontSize);
          const align = s.align || 'left';
          const lines = maxWpt
            ? layoutParagraphText(s.s, maxWpt, (s.indent || 0) * mb.width, widthOf)
            : s.s.split('\n').map(t => ({ s: t, last: true, ind: 0 }));

          lines.forEach((ln, idx) => {
            if (!ln.s) return;
            const y = topY - lead - ascent - idx * lh;
            const lw = widthOf(ln.s);
            if (maxWpt && align === 'justify' && !ln.last) {
              const ws = ln.s.split(/\s+/).filter(Boolean);
              if (ws.length > 1) {
                const total = ws.reduce((t, k) => t + widthOf(k), 0);
                const gap = Math.max(0, (maxWpt - ln.ind - total) / (ws.length - 1));
                let cx = x + ln.ind;
                ws.forEach(k => {
                  p.drawText(k, { x: cx, y, size: fontSize, font, color });
                  cx += widthOf(k) + gap;
                });
                return;
              }
            }
            let dx = ln.ind;
            if (maxWpt && align === 'center') dx = (maxWpt - lw) / 2;
            else if (maxWpt && align === 'right') dx = maxWpt - lw;
            p.drawText(ln.s, { x: x + dx, y, size: fontSize, font, color });
          });
        } catch (_) {
          fallbackRaster.push(s);
        }
      } else {
        fallbackRaster.push(s);
      }
    }

    if (fallbackRaster.length) {
      const k = 2, c = document.createElement('canvas');
      c.width = pg.w * k; c.height = pg.h * k;
      shapes(c.getContext('2d'), fallbackRaster, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      c.width = 0; c.height = 0;
      const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
      p.drawImage(img, { x: mb.x, y: mb.y, width: mb.width, height: mb.height });
    }
  }

  return await out.save();
}

async function save(asNew) {
  if (S.closeEditor) S.closeEditor(false);

  if (!asNew && S.fileHandle) {
    const ok = confirm(`"${S.name}" dosyasının üzerine kaydedilsin mi?`);
    if (!ok) return;
  }

  const btn = $(asNew ? '#saveAs' : '#save');
  btn.disabled = true;

  try {
    const data = await buildPdfBytes();

    if (!asNew && S.fileHandle) {
      const perm = await S.fileHandle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') throw new Error('Dosyaya yazma izni verilmedi.');
      const writable = await S.fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
      toast(`"${S.name}" üzerine kaydedildi.`);
    } else if (window.showSaveFilePicker) {
      const suggested = asNew
        ? S.name.replace(/\.pdf$/i, '') + '-kopya.pdf'
        : S.name;
      const newHandle = await window.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'PDF Dosyası', accept: { 'application/pdf': ['.pdf'] } }]
      });
      const writable = await newHandle.createWritable();
      await writable.write(data);
      await writable.close();
      if (!asNew) {
        S.fileHandle = newHandle;
        S.name = newHandle.name;
      }
      toast(asNew ? 'Farklı konumda kaydedildi.' : `"${newHandle.name}" kaydedildi.`);
    } else {
      const fname = S.name.replace(/\.pdf$/i, '') + (asNew ? '-kopya' : '-duzenlendi') + '.pdf';
      triggerDownload(data, fname);
      toast(asNew ? 'Yeni dosya indirildi.' : 'Kaydedildi.');
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') {
      toast('Kaydedilemedi: ' + (e.message || 'bilinmeyen hata'), true);
    }
  }
  btn.disabled = false;
}

$('#save').onclick = () => save(false);
$('#saveAs').onclick = () => save(true);

/* ---------- Yazdır ---------- */
async function printPdf() {
  if (!S.doc) return;
  if (S.closeEditor) S.closeEditor(false);

  const btn = $('#print');
  btn.disabled = true;
  let url = null;
  try {
    toast('Yazdırma belgesi hazırlanıyor...');
    const data = await buildPdfBytes();
    const blob = new Blob([data], { type: 'application/pdf' });
    url = URL.createObjectURL(blob);

    let frame = document.getElementById('print-frame');
    if (frame) frame.remove();
    frame = document.createElement('iframe');
    frame.id = 'print-frame';
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(frame);

    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (_) {
        window.open(url, '_blank');
      }
      setTimeout(() => {
        if (frame && frame.parentNode) frame.remove();
        if (url) URL.revokeObjectURL(url);
      }, 60000);
    };

    frame.onload = () => setTimeout(doPrint, 200);
    frame.src = url;

    setTimeout(() => {
      if (!printed) {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
          printed = true;
        } catch (_) {
          window.open(url, '_blank');
          printed = true;
        }
      }
    }, 1500);
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    toast('Yazdırma hazırlanamadı: ' + (e.message || 'bilinmeyen hata'), true);
  }
  btn.disabled = false;
}

$('#print').onclick = printPdf;

addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && S.doc) {
    e.preventDefault();
    printPdf();
  }
});

/* ---------- Dosya Açma, Sürükle-Bırak ve Örnek PDF ---------- */
async function openFile(f, fileHandle = null) {
  if (!f) return;
  if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
    return toast('Lütfen geçerli bir PDF dosyası seçin.', true);
  }
  load(new Uint8Array(await f.arrayBuffer()), f.name, fileHandle);
}

$('#file').addEventListener('click', async e => {
  if (!window.showOpenFilePicker) return;
  e.preventDefault();
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'PDF Dosyası', accept: { 'application/pdf': ['.pdf'] } }],
      multiple: false
    });
    const f = await handle.getFile();
    openFile(f, handle);
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('Dosya açılamadı.', true);
  }
});

$('#file').onchange = e => { openFile(e.target.files[0], null); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); $('#empty').classList.add('drag'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#empty').classList.remove('drag'); });
addEventListener('drop', async e => {
  e.preventDefault();
  $('#empty').classList.remove('drag');
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') {
        return openFile(await handle.getFile(), handle);
      }
    } catch (_) {}
  }
  openFile(e.dataTransfer.files[0], null);
});

$('#sample').onclick = async () => {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  ['Ornek belge', 'Ikinci sayfa'].forEach(t => {
    const p = d.addPage([595, 842]);
    p.drawText(t, { x: 60, y: 760, size: 28, font: f, color: rgb(0.1, 0.15, 0.3) });
    p.drawText('Metin, vurgu ve cizim araclarini bu sayfada deneyin.', { x: 60, y: 720, size: 13, font: f });
    p.drawRectangle({ x: 60, y: 520, width: 475, height: 160, borderColor: rgb(0.6, 0.65, 0.75), borderWidth: 1 });
  });
  load(await d.save(), 'ornek.pdf', null);
};

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}