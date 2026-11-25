/* ---------- OCR (Tesseract.js, Türkçe) ve Stil Algılama ---------- */
let ocrWorker = null;
let ocrWorkerLoading = null;

const FONT_OPTIONS = [
  { label: 'IBM Plex Sans', value: '"IBM Plex Sans", Arial, sans-serif' },
  { label: 'Arial / Düz',   value: 'Arial, Helvetica, sans-serif' },
  { label: 'Times (Serif)', value: '"Times New Roman", Times, serif' },
  { label: 'Georgia',       value: 'Georgia, serif' },
  { label: 'Courier (Mono)',value: '"Courier New", Courier, monospace' }
];

// Sayfa boyutuna ve işlem türüne göre bellek dostu dengeli OCR ölçeği
function ocrScale(pg, forRegion = false) {
  const maxPx = forRegion
    ? (isMobile() ? 8e6 : 16e6)
    : (isMobile() ? 4e6 : 9e6);
  const maxScale = forRegion
    ? (300 / 72)
    : (isMobile() ? 2.4 : 3.0);
  const area = Math.max(1, pg.w * pg.h);
  return Math.max(0.5, Math.min(maxScale, Math.sqrt(maxPx / area)));
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (ocrWorkerLoading) return ocrWorkerLoading;
  ocrWorkerLoading = (async () => {
    toast('Türkçe OCR modeli yükleniyor...');
    const w = await Tesseract.createWorker('tur', 1);
    ocrWorker = w;
    ocrWorkerLoading = null;
    return w;
  })();
  return ocrWorkerLoading;
}

function hitTestOcr(pg, x, y) {
  if (!pg.ocrCache) return null;
  let target = null, minArea = Infinity;
  for (const seg of pg.ocrCache) {
    const px = Math.max(0.004, seg.w * 0.04);
    const py = Math.max(0.003, seg.h * 0.22);
    if (x >= seg.x - px && x <= seg.x + seg.w + px && y >= seg.y - py && y <= seg.y + seg.h + py) {
      const a = seg.w * seg.h;
      if (a < minArea) { minArea = a; target = seg; }
    }
  }
  return target;
}

// Dijital PDF'lerde seçilen kutudaki gerçek font ailesi, kalınlık ve italik bilgisini okur
async function detectPdfTextStyle(pg, box) {
  const def = { font: FONT_OPTIONS[0].value, bold: false, italic: false };
  try {
    if (!pg.textContent) {
      const page = await S.doc.getPage(pg.n);
      pg.textContent = await page.getTextContent();
      pg.vp1 = page.getViewport({ scale: 1, rotation: 0 });
    }
    const { items, styles } = pg.textContent;
    if (!items || !items.length) return def;

    const vp = pg.vp1;
    let bestItem = null;
    let bestOverlap = 0;

    for (const it of items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const iw = (it.width || 0) / vp.width;
      const ih = (it.height || Math.abs(it.transform[3]) || 10) / vp.height;
      const ix = vx / vp.width;
      const iy = (vy / vp.height) - ih;

      const ox = Math.max(0, Math.min(box.x + box.w, ix + iw) - Math.max(box.x, ix));
      const oy = Math.max(0, Math.min(box.y + box.h, iy + ih) - Math.max(box.y, iy));
      const overlap = ox * oy;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestItem = it;
      }
    }

    if (!bestItem) return def;

    const st = (styles && styles[bestItem.fontName]) || {};
    const info = `${bestItem.fontName || ''} ${st.fontFamily || ''}`.toLowerCase();

    const bold = /bold|black|heavy|semibold|demi|\bbd\b/.test(info);
    const italic = /italic|oblique|\bit\b/.test(info);

    let font = FONT_OPTIONS[0].value;
    if (/mono|courier|consolas/.test(info)) {
      font = FONT_OPTIONS[4].value;
    } else if (/georgia/.test(info)) {
      font = FONT_OPTIONS[3].value;
    } else if (/times|serif|garamond|cambria|palatino|minion/.test(info) && !/sans/.test(info)) {
      font = FONT_OPTIONS[2].value;
    } else if (/arial|helvetica|calibri|verdana|tahoma/.test(info)) {
      font = FONT_OPTIONS[1].value;
    }

    return { font, bold, italic };
  } catch (_) {
    return def;
  }
}

async function ensureOcrCache(pg) {
  if (pg.ocrCache || pg.ocrLoading) return;
  pg.ocrLoading = true;
  const c = document.createElement('canvas');
  try {
    toast(`Sayfa ${pg.n} metin kutuları hazırlanıyor...`);
    const w = await getOcrWorker();
    const page = await S.doc.getPage(pg.n);
    const vp = page.getViewport({ scale: ocrScale(pg, false), rotation: 0 });
    c.width = vp.width;
    c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;

    const { data } = await w.recognize(c);
    const cw = c.width, ch = c.height;
    const boxes = [];

    for (const ln of (data.lines || [])) {
      const words = (ln.words || []).filter(wd => wd.text && wd.text.trim());
      if (!words.length) continue;
      let seg = [words[0]];
      const flush = () => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const wd of seg) {
          x0 = Math.min(x0, wd.bbox.x0 / cw); y0 = Math.min(y0, wd.bbox.y0 / ch);
          x1 = Math.max(x1, wd.bbox.x1 / cw); y1 = Math.max(y1, wd.bbox.y1 / ch);
        }
        boxes.push({
          text: seg.map(wd => wd.text.trim()).join(' '),
          x: x0, y: y0, w: x1 - x0, h: y1 - y0, lineH: y1 - y0
        });
      };
      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1].bbox, cur = words[i].bbox;
        const h = Math.max(prev.y1 - prev.y0, cur.y1 - cur.y0);
        const gap = cur.x0 - prev.x1;
        if (gap > h * 1.8) { flush(); seg = [words[i]]; }
        else seg.push(words[i]);
      }
      flush();
    }

    pg.ocrCache = boxes;
    paint(pg);
    toast(`Sayfa ${pg.n} düzenlemeye hazır. Bir kutuya dokunun.`);
  } catch (err) {
    console.error(err);
    toast('OCR hatası: ' + err.message, true);
  } finally {
    c.width = 0; c.height = 0;
    pg.ocrLoading = false;
  }
}

function sampleBgColor(pg, box, R) {
  const c = pg.baseCanvas;
  if (!c) return $('#bgColor').value;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const cw = c.width, ch = c.height;

  const corners = [
    fromRaw(R, box.x, box.y), fromRaw(R, box.x + box.w, box.y),
    fromRaw(R, box.x, box.y + box.h), fromRaw(R, box.x + box.w, box.y + box.h)
  ];
  const xs = corners.map(p => p[0] * cw);
  const ys = corners.map(p => p[1] * ch);

  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 3);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 3);
  const x1 = Math.min(cw - 1, Math.ceil(Math.max(...xs)) + 3);
  const y1 = Math.min(ch - 1, Math.ceil(Math.max(...ys)) + 3);

  const rs = [], gs = [], bs = [];
  const px = (x, y) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
  };
  const sx = Math.max(1, Math.floor((x1 - x0) / 10));
  const sy = Math.max(1, Math.floor((y1 - y0) / 6));
  for (let x = x0; x <= x1; x += sx) { px(x, y0); px(x, y1); }
  for (let y = y0; y <= y1; y += sy) { px(x0, y); px(x1, y); }

  if (!rs.length) return $('#bgColor').value;
  const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const r = med(rs), g = med(gs), b = med(bs);
  if (r > 240 && g > 240 && b > 240) return '#ffffff';
  const hx = n => n.toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

async function ocrRegionEdit(pg, sel, R) {
  const full = document.createElement('canvas');
  const crop = document.createElement('canvas');
  try {
    toast('Seçilen bölge okunuyor...');
    const w = await getOcrWorker();
    const page = await S.doc.getPage(pg.n);
    const vp = page.getViewport({ scale: ocrScale(pg, true), rotation: 0 });
    full.width = vp.width;
    full.height = vp.height;
    await page.render({ canvasContext: full.getContext('2d'), viewport: vp }).promise;

    const sx = Math.max(0, Math.floor(sel.x * full.width));
    const sy = Math.max(0, Math.floor(sel.y * full.height));
    const sw = Math.max(10, Math.min(full.width - sx, Math.ceil(sel.w * full.width)));
    const sh = Math.max(10, Math.min(full.height - sy, Math.ceil(sel.h * full.height)));

    crop.width = sw;
    crop.height = sh;
    crop.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);

    const { data } = await w.recognize(crop);
    const text = (data.text || '').trim().replace(/\n{2,}/g, '\n');
    const lines = (data.lines || []).filter(l => l.text && l.text.trim());

    let estLineH = sel.h;
    if (lines.length) {
      const hs = lines.map(l => (l.bbox.y1 - l.bbox.y0) / full.height).filter(h => h > 0.004);
      if (hs.length) estLineH = hs.reduce((a, b) => a + b, 0) / hs.length;
    }

    openFloatingOcrEditor(pg, { text, x: sel.x, y: sel.y, w: sel.w, h: sel.h, lineH: estLineH }, R);
  } catch (err) {
    console.error(err);
    toast('Bölge okunamadı: ' + err.message, true);
  } finally {
    full.width = 0; full.height = 0;
    crop.width = 0; crop.height = 0;
  }
}

async function openFloatingOcrEditor(pg, box, R) {
  if (S.closeEditor) S.closeEditor(true);
  const sheet = pg.ov.parentElement;

  const prevApplied = box.appliedShapes || [];
  pg.editingHide = prevApplied;

  const detectedBg = sampleBgColor(pg, box, R);
  $('#bgColor').value = detectedBg;
  const initColor = isDarkColor(detectedBg) ? '#ffffff' : '#111111';
  const initFontPx = Math.max(8, Math.round(box.lineH * pg.h * 0.88));
  const detectedStyle = await detectPdfTextStyle(pg, box);

  const state = {
    text: box.text,
    fontPx: initFontPx,
    font: box.lastFont || detectedStyle.font,
    bold: box.lastBold ?? detectedStyle.bold,
    italic: box.lastItalic ?? detectedStyle.italic,
    color: initColor,
    bg: detectedBg
  };

  const fontOptsHtml = FONT_OPTIONS.map(o =>
    `<option value='${o.value}'${o.value === state.font ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  const pop = document.createElement('div');
  pop.className = 'ocr-popover';
  pop.innerHTML = `
    <div class="ocr-popover-bar">
      <select id="ocrFont" aria-label="Yazı tipi" title="Yazı tipi">${fontOptsHtml}</select>
      <label>Boyut: <input type="number" id="ocrSz" min="6" max="120" value="${state.fontPx}"></label>
      <button type="button" id="ocrB" class="${state.bold ? 'active' : ''}" title="Kalın"><b>B</b></button>
      <button type="button" id="ocrI" class="${state.italic ? 'active' : ''}" title="İtalik"><i>I</i></button>
      <label>Yazı: <input type="color" id="ocrFg" value="${state.color}"></label>
      <label>Zemin: <input type="color" id="ocrBg" value="${state.bg}"></label>
    </div>
    <textarea id="ocrTa" placeholder="Metni buraya yazın (boş bırakırsanız alan silinir)..."></textarea>
    <div class="ocr-popover-actions">
      <span class="ocr-popover-hint">Ctrl+Enter: Uygula • Esc: İptal</span>
      <div class="ocr-popover-btns">
        <button type="button" class="sec" id="ocrCancel">İptal</button>
        <button type="button" class="pri" id="ocrApply">Uygula ✓</button>
      </div>
    </div>
  `;

  if (isMobile()) {
    document.body.appendChild(pop);
  } else {
    const [sx0, sy0] = fromRaw(R, box.x, box.y);
    const [sx1, sy1] = fromRaw(R, box.x + box.w, box.y + box.h);
    const leftPx = Math.max(8, Math.min(sheet.clientWidth - 490, Math.min(sx0, sx1) * sheet.clientWidth));
    const topPx = Math.max(sy0, sy1) * sheet.clientHeight + 10;
    pop.style.left = leftPx + 'px';
    pop.style.top = topPx + 'px';
    sheet.appendChild(pop);
  }

  const ta = pop.querySelector('#ocrTa');
  const fontSel = pop.querySelector('#ocrFont');
  const szInp = pop.querySelector('#ocrSz');
  const btnB = pop.querySelector('#ocrB');
  const btnI = pop.querySelector('#ocrI');
  const fgInp = pop.querySelector('#ocrFg');
  const bgInp = pop.querySelector('#ocrBg');
  ta.value = state.text;

  const buildShapes = () => {
    const padX = 0.002, padY = 0.002;
    const cover = {
      t: 'white', c: state.bg,
      x: Math.max(0, box.x - padX), y: Math.max(0, box.y - padY),
      w: box.w + padX * 2, h: box.h + padY * 2
    };
    const out = [cover];
    if (state.text.trim()) {
      out.push({
        t: 'text', c: state.color,
        x: box.x, y: box.y,
        s: state.text,
        size: state.fontPx / pg.w,
        font: state.font,
        bold: state.bold, italic: state.italic, lh: 1.25
      });
    }
    return out;
  };

  const renderPreview = () => {
    pg.preview = [...buildShapes(), { t: 'sel', x: box.x, y: box.y, w: box.w, h: box.h }];
    paint(pg);
  };

  ta.oninput = () => { state.text = ta.value; renderPreview(); };
  fontSel.onchange = () => { state.font = fontSel.value; renderPreview(); };
  szInp.oninput = () => { state.fontPx = Math.max(6, Number(szInp.value) || 12); renderPreview(); };
  btnB.onclick = () => { state.bold = !state.bold; btnB.classList.toggle('active', state.bold); renderPreview(); };
  btnI.onclick = () => { state.italic = !state.italic; btnI.classList.toggle('active', state.italic); renderPreview(); };
  fgInp.oninput = () => { state.color = fgInp.value; renderPreview(); };
  bgInp.oninput = () => { state.bg = bgInp.value; $('#bgColor').value = state.bg; renderPreview(); };

  const close = cancel => {
    S.closeEditor = null;
    if (pop.parentNode) pop.remove();
    pg.preview = [];
    pg.editingHide = null;

    if (!cancel) {
      const added = buildShapes();
      const prevText = box.text;

      for (const s of prevApplied) {
        const idx = pg.shapes.indexOf(s);
        if (idx >= 0) pg.shapes.splice(idx, 1);
      }

      box.text = state.text.trim();
      box.lastFont = state.font;
      box.lastBold = state.bold;
      box.lastItalic = state.italic;
      box.appliedShapes = added;
      pg.shapes.push(...added);

      push(() => {
        for (const s of added) {
          const idx = pg.shapes.indexOf(s);
          if (idx >= 0) pg.shapes.splice(idx, 1);
        }
        pg.shapes.push(...prevApplied);
        box.appliedShapes = prevApplied;
        box.text = prevText;
      });
      toast('Metin güncellendi.');
    }
    paint(pg);
  };

  S.closeEditor = close;

  pop.querySelector('#ocrCancel').onclick = () => close(true);
  pop.querySelector('#ocrApply').onclick = () => close(false);
  ta.onkeydown = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(true); }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); close(false); }
  };

  renderPreview();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function isDarkColor(hex) {
  const c = hex.substring(1), rgb = parseInt(c, 16);
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) < 128;
}