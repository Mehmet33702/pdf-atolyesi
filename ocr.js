/* ---------- OCR (Tesseract.js, Türkçe), Renk/Paragraf Gruplama ve Boyutlandırılabilir Sayfa Üstü Düzenleme ---------- */
let ocrWorker = null;
let ocrWorkerLoading = null;

const FONT_OPTIONS = [
  { label: 'Arial / Düz',   value: 'Arial, Helvetica, sans-serif' },
  { label: 'IBM Plex Sans', value: '"IBM Plex Sans", Arial, sans-serif' },
  { label: 'Times (Serif)', value: '"Times New Roman", Times, serif' },
  { label: 'Georgia',       value: 'Georgia, serif' },
  { label: 'Courier (Mono)',value: '"Courier New", Courier, monospace' }
];

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
    const px = Math.max(0.003, seg.w * 0.015);
    const py = Math.max(0.002, seg.h * 0.05);
    if (x >= seg.x - px && x <= seg.x + seg.w + px && y >= seg.y - py && y <= seg.y + seg.h + py) {
      const a = seg.w * seg.h;
      if (a < minArea) { minArea = a; target = seg; }
    }
  }
  return target;
}

const rgbToHex = ([r, g, b]) =>
  '#' + [r, g, b].map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');

const colorDist = (a, b) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function sampleInkRgbFromCtx(ctx, cw, ch, x0, y0, x1, y1) {
  const rx = Math.max(0, Math.floor(x0));
  const ry = Math.max(0, Math.floor(y0));
  const rw = Math.max(1, Math.min(cw - rx, Math.ceil(x1) - rx));
  const rh = Math.max(1, Math.min(ch - ry, Math.ceil(y1) - ry));

  const data = ctx.getImageData(rx, ry, rw, rh).data;
  const step = Math.max(1, Math.floor(Math.sqrt((rw * rh) / 250)));

  const bgR = [], bgG = [], bgB = [];
  const corners = [0, (rw - 1) * 4, ((rh - 1) * rw) * 4, ((rh - 1) * rw + (rw - 1)) * 4];
  for (const idx of corners) {
    bgR.push(data[idx]); bgG.push(data[idx + 1]); bgB.push(data[idx + 2]);
  }
  const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const bg = [med(bgR), med(bgG), med(bgB)];

  const cands = [];
  for (let y = 0; y < rh; y += step) {
    for (let x = 0; x < rw; x += step) {
      const i = (y * rw + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
      if (d > 48) cands.push([d, r, g, b]);
    }
  }
  if (!cands.length) return [20, 20, 20];

  cands.sort((a, b) => b[0] - a[0]);
  const top = cands.slice(0, Math.max(1, Math.ceil(cands.length * 0.4)));
  return [
    med(top.map(p => p[1])),
    med(top.map(p => p[2])),
    med(top.map(p => p[3]))
  ];
}

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

function groupLinesIntoParagraphs(lines) {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  const bulletRe = /^([•●▪▫\-–—\*]|[A-Ea-e][\.\)]|\d+[\.\)])\s/;

  for (const ln of sorted) {
    let best = null, bestGap = Infinity;

    for (const g of groups) {
      if (ln.ink && g.ink && colorDist(ln.ink, g.ink) > 68) continue;

      const last = g.lines[g.lines.length - 1];
      const avgH = g.lineH;
      const gapY = ln.y - (last.y + last.h);

      if (gapY < -avgH * 0.25 || gapY > avgH * 0.85) continue;

      const hRatio = ln.h / avgH;
      if (hRatio < 0.72 || hRatio > 1.38) continue;

      const gRight = g.x + g.w;
      const lRight = ln.x + ln.w;
      const overlapX = Math.min(gRight, lRight) - Math.max(g.x, ln.x);
      const minW = Math.min(g.w, ln.w);
      const maxW = Math.max(g.w, ln.w);
      const leftDiff = Math.abs(ln.x - g.x);

      if (overlapX <= minW * 0.5) continue;
      if (leftDiff > avgH * 2.5 && overlapX < maxW * 0.6) continue;

      const cand = {
        x: Math.min(g.x, ln.x),
        y: Math.min(g.y, ln.y),
        w: Math.max(gRight, lRight) - Math.min(g.x, ln.x),
        h: Math.max(g.y + g.h, ln.y + ln.h) - Math.min(g.y, ln.y)
      };
      let collides = false;
      for (const other of groups) {
        if (other === g) continue;
        if (overlapArea(cand, other) > 0.0001) { collides = true; break; }
      }
      if (collides) continue;

      if (gapY < bestGap) {
        bestGap = gapY;
        best = g;
      }
    }

    if (best) {
      best.lines.push(ln);
      const x0 = Math.min(best.x, ln.x);
      const y0 = Math.min(best.y, ln.y);
      const x1 = Math.max(best.x + best.w, ln.x + ln.w);
      const y1 = Math.max(best.y + best.h, ln.y + ln.h);
      best.x = x0; best.y = y0; best.w = x1 - x0; best.h = y1 - y0;
      const hs = best.lines.map(l => l.h).sort((a, b) => a - b);
      best.lineH = hs[Math.floor(hs.length / 2)];
    } else {
      groups.push({
        lines: [ln],
        x: ln.x, y: ln.y, w: ln.w, h: ln.h,
        lineH: ln.h,
        ink: ln.ink
      });
    }
  }

  return groups.map(g => {
    let text = '';
    for (let i = 0; i < g.lines.length; i++) {
      const cur = g.lines[i];
      if (i === 0) {
        text = cur.text;
        continue;
      }
      const prev = g.lines[i - 1];
      const isNewBullet = bulletRe.test(cur.text);
      const prevShort = prev.w < g.w * 0.78;

      if (isNewBullet || prevShort) {
        text += '\n' + cur.text;
      } else {
        text += ' ' + cur.text;
      }
    }
    return {
      text,
      x: g.x, y: g.y, w: g.w, h: g.h,
      lineH: g.lineH,
      inkHex: g.ink ? rgbToHex(g.ink) : null
    };
  });
}

async function detectPdfTextStyle(pg, box) {
  const def = { font: FONT_OPTIONS[0].value, bold: false, italic: false, fontPx: null };
  try {
    if (!pg.textContent) {
      const page = await S.doc.getPage(pg.n);
      pg.textContent = await page.getTextContent();
      pg.vp1 = page.getViewport({ scale: 1, rotation: 0 });
    }
    const { items, styles } = pg.textContent;
    if (!items || !items.length) return def;

    const vp = pg.vp1;
    const matchedSizes = [];
    const fontVotes = new Map();
    let totalW = 0, boldW = 0, italicW = 0;

    for (const it of items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const ptSize = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      const iw = (it.width || 0) / vp.width;
      const ih = ptSize / vp.height;
      const ix = vx / vp.width;
      const iy = (vy / vp.height) - ih;

      const ox = Math.max(0, Math.min(box.x + box.w, ix + iw) - Math.max(box.x, ix));
      const oy = Math.max(0, Math.min(box.y + box.h, iy + ih) - Math.max(box.y, iy));
      const overlap = ox * oy;
      if (overlap <= 0) continue;

      const weight = overlap * Math.max(1, it.str.trim().length);
      totalW += weight;
      matchedSizes.push(ptSize);

      const st = (styles && styles[it.fontName]) || {};
      const info = `${it.fontName || ''} ${st.fontFamily || ''}`.toLowerCase();

      if (/bold|black|heavy|semibold|demi|\bbd\b/.test(info)) boldW += weight;
      if (/italic|oblique|\bit\b/.test(info)) italicW += weight;

      let fam = FONT_OPTIONS[0].value;
      if (/mono|courier|consolas|menlo/.test(info)) {
        fam = FONT_OPTIONS[4].value;
      } else if (/georgia/.test(info)) {
        fam = FONT_OPTIONS[3].value;
      } else if (/times|serif|garamond|cambria|palatino|minion|antiqua|century/.test(info) && !/sans/.test(info)) {
        fam = FONT_OPTIONS[2].value;
      } else if (/plex/.test(info)) {
        fam = FONT_OPTIONS[1].value;
      }
      fontVotes.set(fam, (fontVotes.get(fam) || 0) + weight);
    }

    if (!totalW) return def;

    let bestFont = FONT_OPTIONS[0].value, bestScore = -1;
    for (const [f, sc] of fontVotes.entries()) {
      if (sc > bestScore) { bestScore = sc; bestFont = f; }
    }

    let fontPx = null;
    if (matchedSizes.length) {
      matchedSizes.sort((a, b) => a - b);
      fontPx = Math.max(6, Math.min(72, Math.round(matchedSizes[Math.floor(matchedSizes.length / 2)])));
    }

    return {
      font: bestFont,
      bold: boldW > totalW * 0.45,
      italic: italicW > totalW * 0.45,
      fontPx
    };
  } catch (_) {
    return def;
  }
}

async function ensureOcrCache(pg) {
  if (pg.ocrCache || pg.ocrLoading) return;
  pg.ocrLoading = true;
  const c = document.createElement('canvas');
  try {
    toast(`Sayfa ${pg.n} metin blokları hazırlanıyor...`);
    const w = await getOcrWorker();
    const page = await S.doc.getPage(pg.n);
    const vp = page.getViewport({ scale: ocrScale(pg, false), rotation: 0 });
    c.width = vp.width;
    c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const { data } = await w.recognize(c);
    const cw = c.width, ch = c.height;
    const rawLines = [];

    for (const ln of (data.lines || [])) {
      const words = (ln.words || []).filter(wd => {
        if (!wd.text || !wd.text.trim()) return false;
        const wh = (wd.bbox.y1 - wd.bbox.y0) / ch;
        if (wh > 0.09) return false;
        if (typeof wd.confidence === 'number' && wd.confidence < 35) return false;
        return true;
      });
      if (!words.length) continue;

      const wordInks = words.map(wd =>
        sampleInkRgbFromCtx(ctx, cw, ch, wd.bbox.x0, wd.bbox.y0, wd.bbox.x1, wd.bbox.y1)
      );

      let seg = [words[0]];
      let segInks = [wordInks[0]];

      const flush = () => {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const whs = [];
        for (const wd of seg) {
          x0 = Math.min(x0, wd.bbox.x0 / cw); y0 = Math.min(y0, wd.bbox.y0 / ch);
          x1 = Math.max(x1, wd.bbox.x1 / cw); y1 = Math.max(y1, wd.bbox.y1 / ch);
          whs.push((wd.bbox.y1 - wd.bbox.y0) / ch);
        }
        whs.sort((a, b) => a - b);
        const medH = whs[Math.floor(whs.length / 2)] || (y1 - y0);
        const med = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
        const ink = [
          med(segInks.map(k => k[0])),
          med(segInks.map(k => k[1])),
          med(segInks.map(k => k[2]))
        ];
        rawLines.push({
          text: seg.map(wd => wd.text.trim()).join(' '),
          x: x0, y: y0, w: x1 - x0, h: Math.min(y1 - y0, medH * 1.45),
          ink
        });
      };

      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1].bbox, cur = words[i].bbox;
        const h = Math.min(prev.y1 - prev.y0, cur.y1 - cur.y0);
        const gap = cur.x0 - prev.x1;
        const diffColor = colorDist(wordInks[i - 1], wordInks[i]) > 72;

        if (gap > h * 1.55 || diffColor) {
          flush();
          seg = [words[i]];
          segInks = [wordInks[i]];
        } else {
          seg.push(words[i]);
          segInks.push(wordInks[i]);
        }
      }
      flush();
    }

    pg.ocrCache = groupLinesIntoParagraphs(rawLines);
    paint(pg);
    toast(`Sayfa ${pg.n} düzenlemeye hazır. Bir paragrafa tıklayın.`);
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
  return rgbToHex([r, g, b]);
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
    const fctx = full.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: fctx, viewport: vp }).promise;

    const sx = Math.max(0, Math.floor(sel.x * full.width));
    const sy = Math.max(0, Math.floor(sel.y * full.height));
    const sw = Math.max(10, Math.min(full.width - sx, Math.ceil(sel.w * full.width)));
    const sh = Math.max(10, Math.min(full.height - sy, Math.ceil(sel.h * full.height)));

    crop.width = sw;
    crop.height = sh;
    crop.getContext('2d').drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);

    const inkHex = rgbToHex(sampleInkRgbFromCtx(fctx, full.width, full.height, sx, sy, sx + sw, sy + sh));
    const { data } = await w.recognize(crop);
    const text = (data.text || '').trim().replace(/\n{2,}/g, '\n');
    const lines = (data.lines || []).filter(l => l.text && l.text.trim());

    let estLineH = sel.h;
    if (lines.length) {
      const hs = lines.map(l => (l.bbox.y1 - l.bbox.y0) / full.height).filter(h => h > 0.004);
      if (hs.length) estLineH = hs.reduce((a, b) => a + b, 0) / hs.length;
    }

    openFloatingOcrEditor(pg, { text, x: sel.x, y: sel.y, w: sel.w, h: sel.h, lineH: estLineH, inkHex }, R);
  } catch (err) {
    console.error(err);
    toast('Bölge okunamadı: ' + err.message, true);
  } finally {
    full.width = 0; full.height = 0;
    crop.width = 0; crop.height = 0;
  }
}

/* ---------- Sayfa Üstünde Boyutlandırılabilir (Word Tarzı) Düzenleyici ---------- */
async function openFloatingOcrEditor(pg, box, R) {
  if (S.closeEditor) S.closeEditor(false);
  const sheet = pg.ov.parentElement;
  const sw = sheet.clientWidth;
  const sh = sheet.clientHeight;
  const rw = R % 180 ? sh : sw;

  const prevApplied = box.appliedShapes || [];
  pg.editingHide = prevApplied;

  const detectedBg = sampleBgColor(pg, box, R);
  $('#bgColor').value = detectedBg;
  const fallbackColor = isDarkColor(detectedBg) ? '#ffffff' : '#111111';
  const initColor = box.inkHex || fallbackColor;
  const detectedStyle = await detectPdfTextStyle(pg, box);

  const estOcrPt = Math.max(8, Math.min(36, Math.round(box.lineH * pg.h * 0.78)));
  const initFontPx = box.lastFontPx || detectedStyle.fontPx || estOcrPt;

  const state = {
    text: box.text,
    fontPx: initFontPx,
    font: box.lastFont || detectedStyle.font,
    bold: box.lastBold ?? detectedStyle.bold,
    italic: box.lastItalic ?? detectedStyle.italic,
    color: box.lastColor || initColor,
    bg: box.lastBg || detectedBg
  };

  // Ekrandaki başlangıç dikdörtgeni
  const [sx0, sy0] = fromRaw(R, box.x, box.y);
  const [sx1, sy1] = fromRaw(R, box.x + box.w, box.y + box.h);
  const rect = {
    left: Math.min(sx0, sx1) * sw,
    top: Math.min(sy0, sy1) * sh,
    width: Math.max(36, Math.abs(sx1 - sx0) * sw),
    height: Math.max(16, Math.abs(sy1 - sy0) * sh)
  };
  let resized = false;

  // 1) Dış çerçeve ve 8 yönlü boyutlandırma tutamaçları
  const wrap = document.createElement('div');
  wrap.className = 'inline-ocr-wrap';

  const ta = document.createElement('textarea');
  ta.className = 'inline-ocr-editor';
  ta.value = state.text;
  ta.spellcheck = false;
  wrap.appendChild(ta);

  // 2) Mini araç çubuğu
  const fontOptsHtml = FONT_OPTIONS.map(o =>
    `<option value='${o.value}'${o.value === state.font ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  const bar = document.createElement('div');
  bar.className = 'inline-ocr-toolbar';
  bar.innerHTML = `
    <select id="ocrFont" aria-label="Yazı tipi" title="Yazı tipi">${fontOptsHtml}</select>
    <label>Boyut: <input type="number" id="ocrSz" min="6" max="120" value="${state.fontPx}"></label>
    <button type="button" id="ocrB" class="${state.bold ? 'active' : ''}" title="Kalın"><b>B</b></button>
    <button type="button" id="ocrI" class="${state.italic ? 'active' : ''}" title="İtalik"><i>I</i></button>
    <label>Yazı: <input type="color" id="ocrFg" value="${state.color}"></label>
    <label>Zemin: <input type="color" id="ocrBg" value="${state.bg}"></label>
    <span class="inline-ocr-sep"></span>
    <button type="button" class="sec" id="ocrCancel" title="İptal (Esc)">İptal</button>
    <button type="button" class="pri" id="ocrApply" title="Uygula (Ctrl+Enter)">✓</button>
  `;

  const applyRect = () => {
    wrap.style.left = rect.left + 'px';
    wrap.style.top = rect.top + 'px';
    wrap.style.width = rect.width + 'px';
    wrap.style.height = rect.height + 'px';
    if (!isMobile()) {
      const barLeft = Math.max(6, Math.min(sw - 510, rect.left));
      const barTop = rect.top > 48 ? (rect.top - 44) : (rect.top + rect.height + 8);
      bar.style.left = barLeft + 'px';
      bar.style.top = barTop + 'px';
    }
  };

  ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(dir => {
    const h = document.createElement('div');
    h.className = `ocr-h ${dir}`;
    h.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY;
      const orig = { ...rect };
      const minW = 28, minH = 14;

      const mv = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (dir.includes('e')) {
          rect.width = Math.max(minW, Math.min(sw - orig.left, orig.width + dx));
        }
        if (dir.includes('w')) {
          const nl = Math.max(0, Math.min(orig.left + orig.width - minW, orig.left + dx));
          rect.width = orig.width + (orig.left - nl);
          rect.left = nl;
        }
        if (dir.includes('s')) {
          rect.height = Math.max(minH, Math.min(sh - orig.top, orig.height + dy));
        }
        if (dir.includes('n')) {
          const nt = Math.max(0, Math.min(orig.top + orig.height - minH, orig.top + dy));
          rect.height = orig.height + (orig.top - nt);
          rect.top = nt;
        }
        resized = true;
        applyRect();
      };
      const up = () => {
        h.removeEventListener('pointermove', mv);
        h.removeEventListener('pointerup', up);
        h.removeEventListener('pointercancel', up);
      };
      h.addEventListener('pointermove', mv);
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
    wrap.appendChild(h);
  });

  sheet.appendChild(wrap);
  if (isMobile()) document.body.appendChild(bar);
  else sheet.appendChild(bar);
  applyRect();

  const fontSel = bar.querySelector('#ocrFont');
  const szInp = bar.querySelector('#ocrSz');
  const btnB = bar.querySelector('#ocrB');
  const btnI = bar.querySelector('#ocrI');
  const fgInp = bar.querySelector('#ocrFg');
  const bgInp = bar.querySelector('#ocrBg');

  const syncEditorStyle = (autoGrow = true) => {
    const px = (state.fontPx / pg.w) * rw;
    ta.style.fontFamily = state.font;
    ta.style.fontSize = px + 'px';
    ta.style.fontWeight = state.bold ? '700' : '400';
    ta.style.fontStyle = state.italic ? 'italic' : 'normal';
    ta.style.color = state.color;
    ta.style.backgroundColor = state.bg;
    if (autoGrow && ta.scrollHeight > rect.height) {
      rect.height = Math.min(sh - rect.top, ta.scrollHeight + 2);
      applyRect();
    }
  };

  // Güncel ekran kutusunu ham PDF koordinatlarına çevirir
  const getRawBox = () => {
    const [rx0, ry0] = toRaw(R, rect.left / sw, rect.top / sh);
    const [rx1, ry1] = toRaw(R, (rect.left + rect.width) / sw, (rect.top + rect.height) / sh);
    return {
      x: Math.min(rx0, rx1),
      y: Math.min(ry0, ry1),
      w: Math.abs(rx1 - rx0),
      h: Math.abs(ry1 - ry0)
    };
  };

  const buildShapes = rawBox => {
    const padX = 0.002, padY = 0.002;
    const cover = {
      t: 'white', c: state.bg,
      x: Math.max(0, rawBox.x - padX), y: Math.max(0, rawBox.y - padY),
      w: rawBox.w + padX * 2, h: rawBox.h + padY * 2
    };
    const out = [cover];
    if (state.text.trim()) {
      out.push({
        t: 'text', c: state.color,
        x: rawBox.x, y: rawBox.y,
        maxW: rawBox.w,
        s: state.text,
        size: state.fontPx / pg.w,
        font: state.font,
        bold: state.bold, italic: state.italic, lh: 1.25
      });
    }
    return out;
  };

  ta.oninput = () => { state.text = ta.value; syncEditorStyle(true); };
  fontSel.onchange = () => { state.font = fontSel.value; syncEditorStyle(true); ta.focus(); };
  szInp.oninput = () => { state.fontPx = Math.max(6, Number(szInp.value) || 12); syncEditorStyle(true); };
  btnB.onclick = () => { state.bold = !state.bold; btnB.classList.toggle('active', state.bold); syncEditorStyle(true); ta.focus(); };
  btnI.onclick = () => { state.italic = !state.italic; btnI.classList.toggle('active', state.italic); syncEditorStyle(true); ta.focus(); };
  fgInp.oninput = () => { state.color = fgInp.value; syncEditorStyle(false); };
  bgInp.oninput = () => { state.bg = bgInp.value; $('#bgColor').value = state.bg; syncEditorStyle(false); };

  const close = cancel => {
    S.closeEditor = null;
    if (wrap.parentNode) wrap.remove();
    if (bar.parentNode) bar.remove();
    pg.preview = [];
    pg.editingHide = null;

    if (!cancel) {
      const changed =
        resized ||
        state.text !== box.text ||
        state.fontPx !== initFontPx ||
        state.font !== (box.lastFont || detectedStyle.font) ||
        state.bold !== (box.lastBold ?? detectedStyle.bold) ||
        state.italic !== (box.lastItalic ?? detectedStyle.italic) ||
        state.color !== (box.lastColor || initColor) ||
        state.bg !== (box.lastBg || detectedBg);

      if (changed) {
        const newRaw = getRawBox();
        const added = buildShapes(newRaw);
        const prevState = {
          text: box.text, x: box.x, y: box.y, w: box.w, h: box.h,
          fontPx: box.lastFontPx, font: box.lastFont,
          bold: box.lastBold, italic: box.lastItalic, color: box.lastColor, bg: box.lastBg
        };

        for (const s of prevApplied) {
          const idx = pg.shapes.indexOf(s);
          if (idx >= 0) pg.shapes.splice(idx, 1);
        }

        box.text = state.text;
        box.x = newRaw.x; box.y = newRaw.y; box.w = newRaw.w; box.h = newRaw.h;
        box.lastFontPx = state.fontPx;
        box.lastFont = state.font;
        box.lastBold = state.bold;
        box.lastItalic = state.italic;
        box.lastColor = state.color;
        box.lastBg = state.bg;
        box.appliedShapes = added;
        pg.shapes.push(...added);

        push(() => {
          for (const s of added) {
            const idx = pg.shapes.indexOf(s);
            if (idx >= 0) pg.shapes.splice(idx, 1);
          }
          pg.shapes.push(...prevApplied);
          box.appliedShapes = prevApplied;
          box.text = prevState.text;
          box.x = prevState.x; box.y = prevState.y; box.w = prevState.w; box.h = prevState.h;
          box.lastFontPx = prevState.fontPx;
          box.lastFont = prevState.font;
          box.lastBold = prevState.bold;
          box.lastItalic = prevState.italic;
          box.lastColor = prevState.color;
          box.lastBg = prevState.bg;
        });
        toast('Paragraf güncellendi.');
      }
    }
    paint(pg);
  };

  S.closeEditor = close;

  bar.querySelector('#ocrCancel').onclick = () => close(true);
  bar.querySelector('#ocrApply').onclick = () => close(false);
  ta.onkeydown = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(true); }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); close(false); }
  };

  paint(pg);
  syncEditorStyle(false);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function isDarkColor(hex) {
  const c = hex.substring(1), rgb = parseInt(c, 16);
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) < 128;
}