/* ---------- Görsel (PNG / JPG / WebP / Ekran Görüntüsü) → Word / Excel Motoru ----------
   Otomatik koyu çerçeve/arayüz temizleme, sahte sütun korumalı tablo algılama,
   hücre bazlı OCR ve tablo/sütun bazlı ondalık-sayı düzeltme.
------------------------------------------------------------------------------------------ */
(function (root) {
  'use strict';

  const median = a => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const normTr = s => String(s == null ? '' : s)
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .normalize('NFC');

  function wordsFromTesseract(data, ch) {
    const lines = [];
    for (const ln of (data.lines || [])) {
      const ws = [];
      for (const wd of (ln.words || [])) {
        const t = normTr(wd.text || '').trim();
        if (!t) continue;
        if (typeof wd.confidence === 'number' && wd.confidence < 25) continue;
        if ((wd.bbox.y1 - wd.bbox.y0) / ch > 0.12) continue;
        ws.push({ t, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, c: wd.confidence });
      }
      if (ws.length) lines.push({ words: ws });
    }
    return lines;
  }

  /* ---------- Koyu Ekran Görüntüsü Çerçevesini / Arayüz Çubuklarını Otomatik Temizle ---------- */
  function stripDarkUiFrame(ctx, cw, ch) {
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const lumAt = (x, y) => {
      const p = (y * cw + x) * 4;
      return (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    };

    let edgeTotal = 0, edgeDark = 0;
    const stepX = Math.max(1, Math.floor(cw / 120));
    const stepY = Math.max(1, Math.floor(ch / 120));
    for (let x = 0; x < cw; x += stepX) {
      for (const y of [0, 2, ch - 3, ch - 1]) {
        if (y < 0 || y >= ch) continue;
        edgeTotal++;
        if (lumAt(x, y) < 115) edgeDark++;
      }
    }
    for (let y = 0; y < ch; y += stepY) {
      for (const x of [0, 2, cw - 3, cw - 1]) {
        if (x < 0 || x >= cw) continue;
        edgeTotal++;
        if (lumAt(x, y) < 115) edgeDark++;
      }
    }

    if (!edgeTotal || (edgeDark / edgeTotal) < 0.40) return null;

    let y0 = -1, y1 = -1, x0 = -1, x1 = -1;
    for (let y = 0; y < ch; y += 2) {
      let light = 0, cnt = 0;
      for (let x = 0; x < cw; x += stepX) {
        cnt++;
        if (lumAt(x, y) > 180) light++;
      }
      if (cnt && (light / cnt) > 0.25) {
        if (y0 < 0) y0 = y;
        y1 = y;
      }
    }
    for (let x = 0; x < cw; x += 2) {
      let light = 0, cnt = 0;
      for (let y = 0; y < ch; y += stepY) {
        cnt++;
        if (lumAt(x, y) > 180) light++;
      }
      if (cnt && (light / cnt) > 0.25) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    }

    if (y0 < 0 || x0 < 0 || (x1 - x0) < cw * 0.30 || (y1 - y0) < ch * 0.30) return null;

    ctx.save();
    ctx.fillStyle = '#ffffff';
    if (y0 > 0) ctx.fillRect(0, 0, cw, y0);
    if (y1 < ch - 1) ctx.fillRect(0, y1 + 1, cw, ch - y1 - 1);
    if (x0 > 0) ctx.fillRect(0, 0, x0, ch);
    if (x1 < cw - 1) ctx.fillRect(x1 + 1, 0, cw - x1 - 1, ch);
    ctx.restore();

    return { x0, y0, x1, y1 };
  }

  function hasInkPixels(ctx, sx, sy, sw, sh) {
    if (sw < 4 || sh < 4) return false;
    const d = ctx.getImageData(sx, sy, sw, sh).data;
    let dark = 0;
    const step = Math.max(1, Math.floor((sw * sh) / 600));
    for (let i = 0; i < d.length; i += 4 * step) {
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
      if (lum < 165) {
        dark++;
        if (dark >= 4) return true;
      }
    }
    return false;
  }

  async function recognizeSingleCell(worker, srcCanvas, srcCtx, rect) {
    const rw = rect.x1 - rect.x0;
    const rh = rect.y1 - rect.y0;
    const insX = Math.max(2, Math.min(6, Math.round(rw * 0.06)));
    const insY = Math.max(2, Math.min(5, Math.round(rh * 0.08)));
    const sx = Math.max(0, Math.floor(rect.x0 + insX));
    const sy = Math.max(0, Math.floor(rect.y0 + insY));
    const sw = Math.floor(rect.x1 - insX) - sx;
    const sh = Math.floor(rect.y1 - insY) - sy;
    if (sw < 4 || sh < 4) return [];
    if (!hasInkPixels(srcCtx, sx, sy, sw, sh)) return [];

    const zoom = sh < 34 ? 2.5 : 2.0;
    const pad = 16;
    const cw = Math.ceil(sw * zoom) + pad * 2;
    const ch = Math.ceil(sh * zoom) + pad * 2;

    const cellCanvas = document.createElement('canvas');
    cellCanvas.width = cw;
    cellCanvas.height = ch;
    const cctx = cellCanvas.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, cw, ch);
    cctx.imageSmoothingEnabled = true;
    cctx.imageSmoothingQuality = 'high';
    cctx.drawImage(srcCanvas, sx, sy, sw, sh, pad, pad, sw * zoom, sh * zoom);

    const { data } = await worker.recognize(cellCanvas);
    cellCanvas.width = cellCanvas.height = 0;

    const outLines = [];
    for (const ln of (data.lines || [])) {
      const ws = [];
      for (const wd of (ln.words || [])) {
        const t = normTr(wd.text || '').replace(/^[|¦]+|[|¦]+$/g, '').trim();
        if (!t) continue;
        const x0 = sx + Math.max(0, (wd.bbox.x0 - pad) / zoom);
        const y0 = sy + Math.max(0, (wd.bbox.y0 - pad) / zoom);
        const x1 = sx + Math.min(sw, (wd.bbox.x1 - pad) / zoom);
        const y1 = sy + Math.min(sh, (wd.bbox.y1 - pad) / zoom);
        ws.push({
          t,
          x0: Math.min(x0, rect.x1 - 1),
          y0: Math.min(y0, rect.y1 - 1),
          x1: Math.max(x0 + 1, Math.min(x1, rect.x1 - 1)),
          y1: Math.max(y0 + 1, Math.min(y1, rect.y1 - 1)),
          c: wd.confidence
        });
      }
      if (ws.length) outLines.push({ words: ws });
    }
    return outLines;
  }

  /* ---------- Tablo Yerleşimi Bittikten Sonra Sütun Bazlı Sayı ve Kesir Ayracı Düzeltme ---------- */
  const looksNumeric = s => /^[\d.,+\-%₺$€\s]+$/.test(s) && /\d/.test(s);

  function cleanNumericCell(raw, hasZeroDotCol, decLen, isDotDecimalTable) {
    let s = String(raw || '').trim();
    if (!s || s.includes('\n')) return s;
    s = s.replace(/^['"`“”.,:;]+|['"`“”.,:;]+$/g, '');
    if (/^[\d\s.,]+$/.test(s)) s = s.replace(/\s+/g, '');

    if (/[A-Za-z]/.test(s) && s.length <= 10) {
      const mapped = s
        .replace(/[OoQq]/g, '0')
        .replace(/[Il|!]/g, '1')
        .replace(/[Zz]/g, '2')
        .replace(/[Aa]/g, '4')
        .replace(/[Ss]/g, '5')
        .replace(/[Tt]/g, '7')
        .replace(/[Bb]/g, '8')
        .replace(/[g]/g, '9');
      if (/^[\d.,+\-]+$/.test(mapped)) s = mapped;
    }

    if (hasZeroDotCol && /^0\d{2,5}$/.test(s)) {
      s = '0.' + s.slice(1);
    } else if (decLen > 0 && /^\d+$/.test(s) && s.length === decLen + 1) {
      s = s.slice(0, 1) + '.' + s.slice(1);
    }

    // Tablo genelinde nokta kesir (ondalık) ayracıysa Excel'in binlik sanmaması için virgüle çevir
    if (isDotDecimalTable && /^[+-]?\d+\.\d+$/.test(s)) {
      s = s.replace('.', ',');
    }
    return s;
  }

  function refineModelTables(model) {
    if (!model || !model.blocks) return;
    for (const b of model.blocks) {
      if (b.type === 'para' || !b.cells || !b.C) continue;

      // 1) Tablo genelinde nokta mı yoksa virgül mü kesir ayracı olarak kullanılmış tespit et
      let zeroDotCnt = 0, non3DotCnt = 0, commaDecCnt = 0;
      for (const cell of b.cells) {
        const t = (cell.text || '').trim();
        if (!t || t.includes('\n')) continue;
        if (/^[+-]?0\.\d+$/.test(t)) zeroDotCnt++;
        if (/^[+-]?\d+\.(\d{1,2}|\d{4,})$/.test(t)) non3DotCnt++;
        if (/^[+-]?\d+(?:\.\d{3})*,\d+$/.test(t)) commaDecCnt++;
      }
      const isDotDecimalTable = (zeroDotCnt >= 1 || non3DotCnt >= 2) && commaDecCnt === 0;

      // 2) Sütun bazlı sayı düzeltme ve kesir ayracı dönüşümü
      for (let c = 0; c < b.C; c++) {
        const colCells = b.cells.filter(cell => cell.c === c && cell.text && cell.text.trim());
        if (colCells.length < 3) continue;

        const texts = colCells.map(cell => cell.text.trim());
        const numTexts = texts.filter(looksNumeric);
        if (numTexts.length < colCells.length * 0.55) continue;

        const hasZeroDotCol = numTexts.filter(s => /^0[.,]\d+$/.test(s)).length >= numTexts.length * 0.35;
        const decLens = numTexts
          .map(s => (s.match(/[.,](\d+)$/) || [])[1])
          .filter(Boolean)
          .map(d => d.length);
        const decLen = decLens.length >= numTexts.length * 0.45 ? Math.round(median(decLens)) : 0;

        for (const cell of colCells) {
          const orig = cell.text.trim();
          if (cell.r === 0 && !/\d/.test(orig)) continue;
          const fixed = cleanNumericCell(orig, hasZeroDotCol, decLen, isDotDecimalTable);
          if (fixed && fixed !== orig) {
            cell.text = fixed;
            if (cell.linesRuns && cell.linesRuns.length === 1 && cell.linesRuns[0].length) {
              cell.linesRuns = [[{ ...cell.linesRuns[0][0], t: fixed }]];
            }
          }
        }
      }
    }
  }

  async function scanImagePage(pg, opts, onStep) {
    const pe = root.PdfExport;
    if (!pe) throw new Error('PdfExport modülü bulunamadı.');

    if (typeof initSystemFonts === 'function') {
      try { await initSystemFonts(); } catch (_) {}
    }

    const page = await S.doc.getPage(pg.n);
    const rot = typeof rotOf === 'function' ? rotOf(pg) : 0;
    const sc = ocrScale(pg, false);
    const vp = page.getViewport({ scale: sc, rotation: rot });

    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const cw = c.width, ch = c.height;
    const baseW = (rot % 180) ? pg.h : pg.w;
    const k = cw / baseW;

    // 1) Görselde koyu çerçeve/arayüz varsa otomatik ayıkla
    stripDarkUiFrame(ctx, cw, ch);

    // 2) Tablo çizgilerini sahte sütun oluşmayacak sıkı eşiklerle bul
    onStep('Görselde tablo ve metin alanları ayrıştırılıyor');
    const img = ctx.getImageData(0, 0, cw, ch);
    const dark = pe.buildDark(img.data, cw, ch, 212);
    const ruling = pe.detectRuling(dark, cw, ch, {
      minH: Math.max(40, Math.round(cw * 0.06)),
      minV: Math.max(40, Math.round(ch * 0.06)),
      maxTh: Math.max(14, Math.round(Math.min(cw, ch) * 0.016))
    });
    const tol = Math.max(5, Math.round(cw * 0.005));
    const tables = pe.findGridTables(ruling, {
      tol,
      minGapX: Math.max(26, Math.round(cw * 0.022)),
      minGapY: Math.max(12, Math.round(ch * 0.010))
    });

    const worker = await getOcrWorker();
    const lines = [];

    if (tables.length) {
      const totalCells = tables.reduce((s, t) => s + t.cells.length, 0);
      let done = 0;
      for (const t of tables) {
        for (const cell of t.cells) {
          done++;
          if (done === 1 || done % 8 === 0 || done === totalCells) {
            onStep(`Tablo hücreleri okunuyor (${done}/${totalCells})`);
          }
          const rect = {
            x0: t.xs[cell.c],
            x1: t.xs[cell.c + cell.cs],
            y0: t.ys[cell.r],
            y1: t.ys[cell.r + cell.rs]
          };
          const cellLines = await recognizeSingleCell(worker, c, ctx, rect);
          lines.push(...cellLines);
        }
      }

      const outside = document.createElement('canvas');
      outside.width = cw;
      outside.height = ch;
      const octx = outside.getContext('2d', { willReadFrequently: true });
      octx.drawImage(c, 0, 0);
      octx.fillStyle = '#ffffff';
      for (const t of tables) {
        octx.fillRect(
          t.xs[0] - tol,
          t.ys[0] - tol,
          (t.xs[t.xs.length - 1] - t.xs[0]) + tol * 2,
          (t.ys[t.ys.length - 1] - t.ys[0]) + tol * 2
        );
      }
      if (hasInkPixels(octx, 0, 0, cw, ch)) {
        onStep('Tablo dışı metinler okunuyor');
        const { data } = await worker.recognize(outside);
        lines.push(...wordsFromTesseract(data, ch));
      }
      outside.width = outside.height = 0;
    } else {
      onStep('Metin okunuyor (OCR)');
      const { data } = await worker.recognize(c);
      lines.push(...wordsFromTesseract(data, ch));
    }

    onStep('Yazı tipi ve hücre yerleşimi çözümleniyor');
    let font = null;
    try {
      const sample = [];
      lines.forEach(l => l.words.forEach(w => sample.push({ t: w.t, w: (w.x1 - w.x0) / cw, c: w.c })));
      const m = await matchFontByWidths(sample, baseW);
      if (m) {
        const fam = pe.pickSafeTurkishFont ? pe.pickSafeTurkishFont(m.family) : m.family;
        font = { family: fam, size: m.size, bold: m.bold, italic: m.italic };
      }
    } catch (_) {}

    const inkAt = (x0, y0, x1, y1) => {
      try {
        const [r, g, b] = sampleInkRgbFromCtx(ctx, cw, ch, x0, y0, x1, y1);
        return (0.299 * r + 0.587 * g + 0.114 * b) < 80 ? null : rgbToHex([r, g, b]);
      } catch (_) { return null; }
    };

    const fillAt = (x0, y0, x1, y1) => {
      try {
        const w = x1 - x0, h = y1 - y0;
        const insX = Math.max(6, Math.min(14, Math.floor(w * 0.15)));
        const insY = Math.max(5, Math.min(12, Math.floor(h * 0.2)));
        if (w < insX * 2.5 || h < insY * 2.5) return null;
        const pts = [
          [x0 + insX, y0 + insY], [x1 - insX, y0 + insY],
          [x0 + insX, y1 - insY], [x1 - insX, y1 - insY]
        ];
        const rs = [], gs = [], bs = [];
        for (const [x, y] of pts) {
          const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
          rs.push(d[0]); gs.push(d[1]); bs.push(d[2]);
        }
        const spread = Math.max(
          Math.max(...rs) - Math.min(...rs),
          Math.max(...gs) - Math.min(...gs),
          Math.max(...bs) - Math.min(...bs)
        );
        if (spread > 28) return null;
        const r = median(rs), g = median(gs), b = median(bs);
        if (r > 235 && g > 235 && b > 235) return null;
        return rgbToHex([r, g, b]);
      } catch (_) { return null; }
    };

    const model = pe.analyzePage({ cw, ch, scale: k, lines, tables, opts, font, inkAt, fillAt, mode: 'image-ocr' });
    refineModelTables(model);
    model.n = pg.n;
    c.width = c.height = 0;
    return model;
  }

  root.ImageExport = { scanImagePage };
})(typeof globalThis !== 'undefined' ? globalThis : this);