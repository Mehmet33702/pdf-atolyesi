/* ---------- Hibrit Bloklama, Kontrastlı OCR, İzinsiz Yerel Font, Sağ Panel ve Kelime Bazlı Zengin Metin ---------- */
let ocrWorker = null;
let ocrWorkerLoading = null;

const FONT_OPTIONS = [
  { label: 'Arial / Düz',   value: 'Arial, Helvetica, sans-serif' },
  { label: 'IBM Plex Sans', value: '"IBM Plex Sans", Arial, sans-serif' },
  { label: 'Times (Serif)', value: '"Times New Roman", Times, serif' },
  { label: 'Georgia',       value: 'Georgia, serif' },
  { label: 'Courier (Mono)',value: '"Courier New", Courier, monospace' }
];

/* ---------- Bilgisayardaki Yazı Tipleri (İzin İstemeden Sessiz Yerel Algılama) ---------- */
const SysFonts = {
  families: [],
  byNorm: new Map(),
  ready: null
};

const PROBE_FONTS = [
  'Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Segoe UI',
  'Courier New', 'Helvetica', 'Helvetica Neue', 'Liberation Serif', 'Liberation Sans', 'Liberation Mono',
  'Arial Narrow', 'Arial Black', 'Arial Unicode MS', 'Candara', 'Consolas', 'Constantia', 'Corbel',
  'Impact', 'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype',
  'Trebuchet MS', 'Book Antiqua', 'Bookman Old Style', 'Garamond', 'Century Gothic', 'Century',
  'Franklin Gothic Medium', 'Gill Sans', 'Gill Sans MT', 'Optima', 'Futura', 'Avenir', 'Baskerville',
  'Didot', 'Hoefler Text', 'Palatino', 'Times', 'Courier', 'Menlo', 'Monaco', 'Comic Sans MS',
  'Rockwell', 'Tw Cen MT', 'Sylfaen', 'Segoe Print', 'Segoe Script', 'Calisto MT', 'Cooper Black',
  'Bahnschrift', 'Sitka Text', 'Roboto', 'Open Sans', 'Noto Sans', 'Noto Serif', 'DejaVu Sans',
  'DejaVu Serif', 'DejaVu Sans Mono', 'Ubuntu', 'Cantarell', 'Droid Sans', 'Droid Serif', 'Source Sans Pro',
  'Lato', 'Montserrat', 'Merriweather', 'PT Sans', 'PT Serif', 'Nunito', 'Poppins', 'Fira Sans',
  'Aptos', 'Aptos Display', 'Aptos Serif', 'Cambria Math', 'Symbol', 'Wingdings',
  'IBM Plex Sans', 'IBM Plex Serif', 'IBM Plex Mono', 'Charter', 'Geneva', 'American Typewriter',
  'Big Caslon', 'Copperplate', 'Papyrus', 'Skia', 'Lucida Grande'
];

const FONT_PRIORITY = [
  'Times New Roman', 'Arial', 'Calibri', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Segoe UI',
  'Courier New', 'Helvetica', 'Liberation Serif', 'Liberation Sans', 'Liberation Mono'
];

const FONT_ALIASES = {
  times: ['Times New Roman', 'Liberation Serif'],
  timesroman: ['Times New Roman', 'Liberation Serif'],
  helvetica: ['Helvetica', 'Arial', 'Liberation Sans'],
  arial: ['Arial', 'Liberation Sans', 'Helvetica'],
  courier: ['Courier New', 'Liberation Mono'],
  symbol: ['Symbol']
};

const normFont = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fontGenericOf(family) {
  const f = String(family || '').toLowerCase();
  if (/\bmono\b|monospace|courier|consolas|console|menlo|monaco|typewriter|fixed/.test(f)) return 'monospace';
  if (/sans|gothic|arial|helvet|calibri|verdana|tahoma|segoe|trebuchet|roboto|ubuntu|lato|candara|corbel|futura|avenir|optima|impact|comic|bahnschrift|aptos|poppins|montserrat|nunito|geneva/.test(f)) return 'sans-serif';
  if (/times|georgia|garamond|palatino|cambria|serif|book|baskerville|didot|minion|constantia|century|rockwell|sylfaen|antiqua|bodoni|caslon|mincho|song|charter|merriweather|sitka/.test(f)) return 'serif';
  return 'sans-serif';
}

const fontCss = family => `"${String(family).replace(/["\\]/g, '')}", ${fontGenericOf(family)}`;

function primaryFamily(css) {
  const first = String(css || '').split(',')[0] || '';
  return first.replace(/["']/g, '').trim();
}

function setSysFamilies(list) {
  const uniq = [...new Set(list)];
  const pr = n => { const i = FONT_PRIORITY.findIndex(p => p.toLowerCase() === n.toLowerCase()); return i < 0 ? 999 : i; };
  uniq.sort((a, b) => (pr(a) - pr(b)) || a.localeCompare(b, 'tr'));
  SysFonts.families = uniq;
  SysFonts.byNorm = new Map();
  for (const f of uniq) { const k = normFont(f); if (k && !SysFonts.byNorm.has(k)) SysFonts.byNorm.set(k, f); }
}

function probeInstalledFonts(names) {
  const c = document.createElement('canvas').getContext('2d');
  const bases = ['monospace', 'serif', 'sans-serif'];
  const sample = 'mmmmmmmmmmlliWÇĞİÖŞÜ';
  const baseW = bases.map(b => { c.font = `72px ${b}`; return c.measureText(sample).width; });
  return names.filter(n => bases.some((b, i) => {
    c.font = `72px "${n}", ${b}`;
    return c.measureText(sample).width !== baseW[i];
  }));
}

function initSystemFonts() {
  if (SysFonts.ready) return SysFonts.ready;
  SysFonts.ready = Promise.resolve().then(() => {
    setSysFamilies([...probeInstalledFonts(PROBE_FONTS), 'IBM Plex Sans']);
    return SysFonts;
  });
  return SysFonts.ready;
}

function matchInstalledFamily(raw) {
  if (!raw) return null;
  const nm = String(raw).replace(/^[A-Z]{6}\+/, '');
  const base = nm.split(/[-,]/)[0];
  const strip = s => s.replace(/(psmt|mt|ps)$/, '');
  const tries = [normFont(nm), normFont(base), strip(normFont(base)), strip(normFont(nm))];
  for (const t of tries) {
    if (t && SysFonts.byNorm.has(t)) return SysFonts.byNorm.get(t);
  }
  for (const t of tries) {
    const al = FONT_ALIASES[t];
    if (al) for (const a of al) { const k = SysFonts.byNorm.get(normFont(a)); if (k) return k; }
  }
  return null;
}

/* ---------- Taranmış Metinden Yazı Tipi Tahmini ---------- */
function fontInkWidths(ctx, family, bold, italic, words) {
  ctx.font = `${italic ? 'italic ' : ''}${bold ? '700' : '400'} 100px "${family}", monospace`;
  return words.map(w => {
    const m = ctx.measureText(w.t);
    return (m.actualBoundingBoxLeft || 0) + (m.actualBoundingBoxRight || 0);
  });
}

function fitFontScale(ms, rs) {
  const idx = [];
  for (let i = 0; i < ms.length; i++) if (ms[i] > 0 && rs[i] > 0) idx.push(i);
  if (idx.length < 3) return null;
  const solve = use => {
    let su = 0, suu = 0;
    for (const i of use) { const u = ms[i] / rs[i]; su += u; suu += u * u; }
    const k = su / suu;
    let err = 0;
    for (const i of use) err += Math.pow(1 - k * (ms[i] / rs[i]), 2);
    return { k, err: err / use.length };
  };
  let fit = solve(idx);
  const keep = idx.filter(i => Math.abs(1 - fit.k * (ms[i] / rs[i])) < 0.22);
  if (keep.length >= 3 && keep.length < idx.length) fit = solve(keep);
  return { err: fit.err, size: fit.k * 100 };
}

async function matchFontByWidths(rawWords, pageWpt, genericHint = null) {
  await initSystemFonts();
  const okWord = (w, minConf) => w && w.t && w.t.length >= 3 && /\p{L}{2,}/u.test(w.t) &&
    /^[\p{L}\p{N}.,;:'’()\-–]+$/u.test(w.t) && w.w > 0 && (w.c == null || w.c >= minConf);
  let words = (rawWords || []).filter(w => okWord(w, 60));
  if (words.length < 4) words = (rawWords || []).filter(w => okWord(w, 35));
  if (words.length < 3) return null;
  words = words.slice(0, 80);

  const rs = words.map(w => w.w * pageWpt);
  const ctx = document.createElement('canvas').getContext('2d');
  let fams = SysFonts.families;
  if (genericHint) {
    const filtered = fams.filter(f => fontGenericOf(f) === genericHint);
    if (filtered.length) fams = filtered;
  } else {
    fams = fams.filter(f => fontGenericOf(f) !== 'monospace');
  }

  const t0 = performance.now();
  const res = [];

  for (let i = 0; i < fams.length; i++) {
    const f = fitFontScale(fontInkWidths(ctx, fams[i], false, false, words), rs);
    if (f) res.push({ fam: fams[i], order: i, ...f });
    if (i % 40 === 39) {
      await new Promise(r => setTimeout(r, 0));
      if (performance.now() - t0 > 2500) break;
    }
  }
  if (!res.length) return null;

  res.sort((a, b) => a.err - b.err);
  const best = res[0];
  if (best.err > 0.05) return null;

  const close = res.filter(r => r.err <= best.err * 1.08 + 0.0002).sort((a, b) => a.order - b.order);
  let pick = { ...close[0], bold: false, italic: false };

  for (const cand of close.slice(0, 4)) {
    for (const [b, it] of [[true, false], [false, true], [true, true]]) {
      const f = fitFontScale(fontInkWidths(ctx, cand.fam, b, it, words), rs);
      if (f && f.err < pick.err * 0.7 && pick.err - f.err > 0.0005) {
        pick = { fam: cand.fam, order: cand.order, ...f, bold: b, italic: it };
      }
    }
  }
  return { family: pick.fam, bold: pick.bold, italic: pick.italic, size: pick.size, err: pick.err };
}

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

/* ---------- Paragraf Başı ve Satır Başına Göre Hibrit Gruplama ---------- */
function groupLinesIntoParagraphs(lines) {
  if (!lines.length) return [];
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups = [];
  const bulletRe = /^([•●▪▫►▶\-–—\*]|[A-Za-zÇĞİÖŞÜçğıöşü][\.\)]|\d+[\.\)])\s/;

  for (const ln of sorted) {
    let mergedSameLine = false;
    for (const g of groups) {
      const last = g.lines[g.lines.length - 1];
      const ovY = Math.min(last.y + last.h, ln.y + ln.h) - Math.max(last.y, ln.y);
      const minH = Math.min(last.h, ln.h);
      if (ovY > minH * 0.5 && ln.x >= g.x - g.lineH && (ln.x + ln.w) <= (g.x + g.w + g.lineH * 1.5)) {
        last.text = (ln.x >= last.x) ? (last.text + ' ' + ln.text) : (ln.text + ' ' + last.text);
        const x0 = Math.min(last.x, ln.x), x1 = Math.max(last.x + last.w, ln.x + ln.w);
        const y0 = Math.min(last.y, ln.y), y1 = Math.max(last.y + last.h, ln.y + ln.h);
        last.x = x0; last.w = x1 - x0; last.y = y0; last.h = y1 - y0;
        last.words = [...(last.words || []), ...(ln.words || [])].sort((a, b) => a.x - b.x);
        g.x = Math.min(g.x, x0);
        g.w = Math.max(g.x + g.w, x1) - g.x;
        mergedSameLine = true;
        break;
      }
    }
    if (mergedSameLine) continue;

    const startsWithBullet = bulletRe.test(ln.text.trim());
    let best = null, bestGap = Infinity;

    if (!startsWithBullet) {
      for (const g of groups) {
        if (ln.ink && g.ink && colorDist(ln.ink, g.ink) > 68) continue;

        const last = g.lines[g.lines.length - 1];
        const avgH = g.lineH;
        const gapY = ln.y - (last.y + last.h);

        if (gapY < -avgH * 0.25 || gapY > avgH * 0.85) continue;

        const hRatio = ln.h / avgH;
        if (hRatio < 0.72 || hRatio > 1.38) continue;

        const prevShort = g.lines.length >= 2 && last.w < g.w * 0.80 && /[.!?:;]$/.test(last.text.trim());
        if (prevShort) continue;

        const bodyLeft = g.lines.length >= 2 ? Math.min(...g.lines.slice(1).map(l => l.x)) : g.x;
        const isNewIndent = (ln.x - bodyLeft) > avgH * 1.1;
        if (isNewIndent) continue;

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
      inkHex: g.ink ? rgbToHex(g.ink) : null,
      words: g.lines.flatMap(l => l.words || []),
      lines: g.lines.map(l => ({ x: l.x, y: l.y, w: l.w, h: l.h, words: l.words || [] }))
    };
  });
}

/* ---------- Paragraf Yerleşimi ---------- */
const medianOf = a => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function justifyRefFrom(paras, W, H) {
  const Rs = [], Ls = [];
  for (const p of paras || []) {
    if ((p.lines || []).length >= 3) {
      const l = detectParagraphLayout({ w: W, h: H }, p, false);
      if (l.align === 'justify') { Rs.push((p.x + p.w) * W); Ls.push(p.x * W); }
    }
  }
  return Rs.length ? { R: medianOf(Rs), L: medianOf(Ls) } : null;
}

function pageJustifyRef(pg) {
  if (!pg || !pg.ocrCache) return null;
  if (pg.__jr === undefined) pg.__jr = justifyRefFrom(pg.ocrCache, pg.w, pg.h);
  return pg.__jr;
}

function detectParagraphLayout(pg, box, jr) {
  if (jr === undefined) jr = pageJustifyRef(pg);
  const res = { align: 'left', indentPt: 0, pitchPt: null };
  const ls = (box.lines || []).map(l => ({
    x0: l.x * pg.w, x1: (l.x + l.w) * pg.w, y0: l.y * pg.h, h: l.h * pg.h, words: l.words || []
  })).sort((a, b) => a.y0 - b.y0);
  const n = ls.length;
  if (!n) return res;

  const Hh = medianOf(ls.map(l => l.h)) || 10;
  const tol = Math.max(1.5, 0.45 * Hh);
  const R = Math.max(...ls.map(l => l.x1));
  const frac = (arr, ref) => arr.filter(v => Math.abs(v - ref) <= tol).length / arr.length;

  if (n >= 2) {
    const d = [];
    for (let i = 1; i < n; i++) d.push(ls[i].y0 - ls[i - 1].y0);
    const p = medianOf(d);
    if (p >= Hh * 0.8 && p <= Hh * 3.5) res.pitchPt = p;
  }

  const gapOf = ln => {
    const w = [...ln.words].sort((a, b) => a.x - b.x);
    if (w.length < 3) return null;
    const gs = [];
    for (let i = 1; i < w.length; i++) gs.push((w[i].x - (w[i - 1].x + w[i - 1].w)) * pg.w);
    return medianOf(gs);
  };

  if (n >= 3) {
    const leftRef = medianOf(ls.slice(1).map(l => l.x0));
    const leftFlush = frac(ls.slice(1).map(l => l.x0), leftRef) >= 0.75;
    const rightFlush = frac(ls.slice(0, n - 1).map(l => l.x1), R) >= 0.75;
    const cxs = ls.map(l => (l.x0 + l.x1) / 2);
    if (rightFlush && leftFlush) res.align = 'justify';
    else if (frac(ls.map(l => l.x1), R) >= 0.8 && !leftFlush) res.align = 'right';
    else if (frac(cxs, medianOf(cxs)) >= 0.8 && !leftFlush) res.align = 'center';
  } else if (n === 2) {
    const [a, b] = ls;
    const cA = (a.x0 + a.x1) / 2, cB = (b.x0 + b.x1) / 2;
    const ga = gapOf(a), gb = gapOf(b);
    if (Math.abs(cA - cB) <= tol && Math.abs(a.x0 - b.x0) > tol * 2) res.align = 'center';
    else if (jr && Math.abs(a.x1 - jr.R) <= tol * 1.5 && b.x1 < a.x1 - tol) res.align = 'justify';
    else if (ga != null && gb != null && ga > gb * 1.15 && a.x1 >= b.x1 && a.words.length >= 4) res.align = 'justify';
  } else {
    const a = ls[0];
    const cx = (a.x0 + a.x1) / 2;
    if (jr && Math.abs(a.x1 - jr.R) <= tol * 1.5 && a.x0 <= jr.L + 3 * Hh) res.align = 'justify';
    else if (Math.abs(cx - pg.w / 2) <= Math.max(tol, 0.012 * pg.w) && (a.x1 - a.x0) < pg.w * 0.85) res.align = 'center';
  }

  if (n >= 2) {
    const base = medianOf(ls.slice(1).map(l => l.x0));
    const d = ls[0].x0 - base;
    if (d > Hh * 0.8 && d < pg.w * 0.25) res.indentPt = d;
  }
  return res;
}

/* ---------- PDF Metin Stilini Algılama ---------- */
async function detectFromPdfText(pg, box) {
  const page = await S.doc.getPage(pg.n);
  if (!pg.textContent) {
    pg.textContent = await page.getTextContent();
    pg.vp1 = page.getViewport({ scale: 1, rotation: 0 });
  }
  const { items, styles } = pg.textContent;
  if (!items || !items.length) return null;

  const fobj = id => {
    try { return page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch (_) { return null; }
  };

  const vp = pg.vp1;
  const matchedSizes = [];
  const votes = new Map();
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

    const fo = fobj(it.fontName);
    const rawName = (fo && fo.name) ? String(fo.name) : '';
    const st = (styles && styles[it.fontName]) || {};
    const info = `${rawName} ${it.fontName || ''} ${st.fontFamily || ''}`.toLowerCase();

    if ((fo && fo.bold) || /bold|black|heavy|semibold|demi|\bbd\b/.test(info)) boldW += weight;
    if ((fo && fo.italic) || /italic|oblique|\bit\b/.test(info)) italicW += weight;

    const key = rawName || it.fontName || '?';
    let v = votes.get(key);
    if (!v) votes.set(key, v = { w: 0, info, mono: false, serif: false });
    v.w += weight;
    if (fo && fo.isMonospace) v.mono = true;
    if (fo && fo.isSerifFont) v.serif = true;
  }
  if (!totalW) return null;

  let bestKey = null, bestW = -1;
  for (const [k, v] of votes) if (v.w > bestW) { bestW = v.w; bestKey = k; }
  const v = votes.get(bestKey);

  const family = /glyphless|invisible|^g_d\d|^\?$/i.test(bestKey) ? null : matchInstalledFamily(bestKey);

  let css = FONT_OPTIONS[0].value;
  let generic = 'sans-serif';
  if (v.mono || /\bmono\b|monospace|courier|consolas|menlo/.test(v.info)) {
    css = FONT_OPTIONS[4].value;
    generic = 'monospace';
  } else if (/georgia/.test(v.info)) {
    css = FONT_OPTIONS[3].value;
    generic = 'serif';
  } else if (v.serif || (/times|serif|garamond|cambria|palatino|minion|antiqua|century|book/.test(v.info) && !/sans/.test(v.info))) {
    css = FONT_OPTIONS[2].value;
    generic = 'serif';
  } else if (/plex/.test(v.info)) {
    css = FONT_OPTIONS[1].value;
    generic = 'sans-serif';
  }

  let fontPx = null;
  if (matchedSizes.length) {
    matchedSizes.sort((a, b) => a - b);
    const medPt = matchedSizes[Math.floor(matchedSizes.length / 2)];
    fontPx = Math.max(6, Math.min(72, Math.round(medPt * 2) / 2));
  }
  return {
    family, genericCss: css, generic, fontPx, rawName: bestKey,
    bold: boldW > totalW * 0.45,
    italic: italicW > totalW * 0.45
  };
}

async function detectPdfTextStyle(pg, box) {
  const out = { font: FONT_OPTIONS[0].value, bold: false, italic: false, fontPx: null, family: null, source: 'default',
                align: 'left', indentPt: 0, pitchPt: null };
  try {
    const lay = detectParagraphLayout(pg, box);
    out.align = lay.align; out.indentPt = lay.indentPt; out.pitchPt = lay.pitchPt;
  } catch (_) {}
  try {
    await initSystemFonts();

    let info = null;
    try { info = await detectFromPdfText(pg, box); } catch (_) {}

    let family = info && info.family;
    let bold = info ? info.bold : false;
    let italic = info ? info.italic : false;
    let fontPx = info ? info.fontPx : null;
    let source = family ? 'pdf' : null;

    if (!family && box.words && box.words.length >= 3) {
      const m = await matchFontByWidths(box.words, pg.w, info ? info.generic : null);
      if (m) {
        family = m.family;
        bold = bold || m.bold;
        italic = italic || m.italic;
        if (!fontPx) fontPx = Math.max(6, Math.min(72, Math.round(m.size * 2) / 2));
        source = 'ocr';
      }
    }

    out.font = family ? fontCss(family) : (info ? info.genericCss : out.font);
    out.family = family;
    out.bold = bold;
    out.italic = italic;
    out.fontPx = fontPx;
    out.source = source || (info ? 'generic' : 'default');
  } catch (e) {
    console.warn('Yazı tipi algılanamadı:', e);
  }
  return out;
}

/* ---------- OCR Kontrast Ön İşleme ---------- */
function preprocessForOcr(srcCanvas) {
  const cw = srcCanvas.width, ch = srcCanvas.height;
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(srcCanvas, 0, 0);
  const img = ctx.getImageData(0, 0, cw, ch);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = g > 225 ? 255 : Math.max(0, Math.min(255, (g - 110) * 1.65 + 110));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ---------- Hibrit Blok Hazırlama: Dijital Metin + Kontrastlı OCR Yedeği ---------- */
async function buildDigitalOcrCache(pg, page) {
  const tc = await page.getTextContent();
  const items = (tc.items || []).filter(it => it.str && it.str.trim());
  const totalChars = items.reduce((s, it) => s + it.str.trim().length, 0);
  if (items.length < 3 || totalChars < 12) return null;

  const joined = items.map(it => it.str.normalize('NFC')).join('');
  const broken = (joined.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
  if (broken > Math.max(2, totalChars * 0.02)) return null;

  const vp = page.getViewport({ scale: 1, rotation: 0 });
  pg.textContent = tc;
  pg.vp1 = vp;

  const rawWords = [];
  for (const it of items) {
    if (!it.transform) continue;
    const angle = Math.abs(Math.atan2(it.transform[1], it.transform[0]) * 180 / Math.PI);
    if (angle > 5 && angle < 355) continue;

    const ptSize = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    if (ptSize < 4 || ptSize > 90) continue;

    const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const raw = it.str.normalize('NFC');
    const wPt = it.width || (raw.length * ptSize * 0.5);
    const y0 = (vy - ptSize) / vp.height;
    const h = ptSize / vp.height;

    const parts = raw.split(/(\s+)/);
    const totalLen = Math.max(1, raw.length);
    let pos = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      const len = part.length;
      if (part.trim()) {
        const x0 = (vx + (pos / totalLen) * wPt) / vp.width;
        const w = Math.max(0.002, ((len / totalLen) * wPt) / vp.width);
        rawWords.push({
          t: part.trim(), x: x0, y: y0, w, h, c: 100,
          leadSp: pi > 0 && /^\s+$/.test(parts[pi - 1]),
          trailSp: pi < parts.length - 1 && /^\s+$/.test(parts[pi + 1])
        });
      }
      pos += len;
    }
  }
  if (rawWords.length < 3) return null;

  rawWords.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
  const lineGroups = [];
  for (const wd of rawWords) {
    const cy = wd.y + wd.h / 2;
    const last = lineGroups[lineGroups.length - 1];
    if (last && Math.abs(cy - last.cy) <= 0.55 * Math.min(wd.h, last.h)) {
      last.words.push(wd);
      last.cy = (last.cy * (last.words.length - 1) + cy) / last.words.length;
      last.h = Math.max(last.h, wd.h);
    } else {
      lineGroups.push({ words: [wd], cy, h: wd.h });
    }
  }

  const rawLines = [];
  for (const lg of lineGroups) {
    lg.words.sort((a, b) => a.x - b.x);
    const merged = [];
    for (const wd of lg.words) {
      const prev = merged[merged.length - 1];
      const gap = prev ? (wd.x - (prev.x + prev.w)) : Infinity;
      if (prev && !prev.trailSp && !wd.leadSp && gap < Math.max(0.002, Math.min(prev.h, wd.h) * 0.22)) {
        prev.t += wd.t;
        prev.w = Math.max(prev.x + prev.w, wd.x + wd.w) - prev.x;
        prev.trailSp = wd.trailSp;
      } else {
        merged.push({ ...wd });
      }
    }

    let seg = [merged[0]];
    const flush = () => {
      const x0 = Math.min(...seg.map(w => w.x));
      const y0 = Math.min(...seg.map(w => w.y));
      const x1 = Math.max(...seg.map(w => w.x + w.w));
      const y1 = Math.max(...seg.map(w => w.y + w.h));
      rawLines.push({
        text: seg.map(w => w.t).join(' '),
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
        ink: null,
        words: seg.map(w => ({ t: w.t, x: w.x, w: w.w, c: 100 }))
      });
    };
    for (let i = 1; i < merged.length; i++) {
      const prev = merged[i - 1], cur = merged[i];
      const gap = cur.x - (prev.x + prev.w);
      if (gap > Math.min(prev.h, cur.h) * 2.6) { flush(); seg = [cur]; }
      else seg.push(cur);
    }
    flush();
  }

  return groupLinesIntoParagraphs(rawLines);
}

async function ensureOcrCache(pg) {
  if (pg.ocrCache || pg.ocrLoading) return;
  pg.ocrLoading = true;
  const c = document.createElement('canvas');
  try {
    const page = await S.doc.getPage(pg.n);
    const digitalBlocks = await buildDigitalOcrCache(pg, page);
    if (digitalBlocks && digitalBlocks.length) {
      pg.ocrCache = digitalBlocks;
      paint(pg);
      toast(`Sayfa ${pg.n} düzenlemeye hazır. Bir paragrafa tıklayın.`);
      return;
    }

    toast(`Sayfa ${pg.n} metin blokları hazırlanıyor...`);
    const w = await getOcrWorker();
    const vp = page.getViewport({ scale: ocrScale(pg, false), rotation: 0 });
    c.width = vp.width;
    c.height = vp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    const pre = preprocessForOcr(c);
    const { data } = await w.recognize(pre);
    pre.width = pre.height = 0;

    const cw = c.width, ch = c.height;
    const rawLines = [];
    const isChromatic = ([r, g, b]) => (Math.max(r, g, b) - Math.min(r, g, b)) > 45;

    for (const ln of (data.lines || [])) {
      const words = (ln.words || []).filter(wd => {
        if (!wd.text || !wd.text.trim()) return false;
        const wh = (wd.bbox.y1 - wd.bbox.y0) / ch;
        if (wh > 0.09) return false;
        if (typeof wd.confidence === 'number' && wd.confidence < 12) return false;
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
          ink,
          words: seg.map(wd => ({ t: wd.text.trim(), x: wd.bbox.x0 / cw, w: (wd.bbox.x1 - wd.bbox.x0) / cw, c: wd.confidence }))
        });
      };

      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1].bbox, cur = words[i].bbox;
        const h = Math.min(prev.y1 - prev.y0, cur.y1 - cur.y0);
        const gap = cur.x0 - prev.x1;
        const diffColor = colorDist(wordInks[i - 1], wordInks[i]) > 95 &&
          (isChromatic(wordInks[i - 1]) || isChromatic(wordInks[i]));

        if (gap > h * 2.2 || diffColor) {
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

/* ---------- Filigranı Koruyan Arka Plan Yaması ---------- */
function createWatermarkSafePatch(pg, rawBox, R) {
  const base = pg.baseCanvas;
  if (!base) return null;
  const cw = base.width, ch = base.height;

  const corners = [
    fromRaw(R, rawBox.x, rawBox.y), fromRaw(R, rawBox.x + rawBox.w, rawBox.y),
    fromRaw(R, rawBox.x, rawBox.y + rawBox.h), fromRaw(R, rawBox.x + rawBox.w, rawBox.y + rawBox.h)
  ];
  const xs = corners.map(p => p[0] * cw);
  const ys = corners.map(p => p[1] * ch);

  const sx = Math.max(0, Math.floor(Math.min(...xs)));
  const sy = Math.max(0, Math.floor(Math.min(...ys)));
  const sw = Math.max(4, Math.min(cw - sx, Math.ceil(Math.max(...xs)) - sx));
  const sh = Math.max(4, Math.min(ch - sy, Math.ceil(Math.max(...ys)) - sy));

  const patch = document.createElement('canvas');
  patch.width = sw;
  patch.height = sh;
  const pctx = patch.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);

  const img = pctx.getImageData(0, 0, sw, sh);
  const d = img.data;
  const isText = new Uint8Array(sw * sh);

  for (let i = 0, p = 0; i < isText.length; i++, p += 4) {
    const lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    if (lum < 178) isText[i] = 1;
  }

  const mask = new Uint8Array(isText);
  for (let y = 1; y < sh - 1; y++) {
    const row = y * sw;
    for (let x = 1; x < sw - 1; x++) {
      const idx = row + x;
      if (isText[idx - 1] || isText[idx + 1] || isText[idx - sw] || isText[idx + sw]) {
        mask[idx] = 1;
      }
    }
  }

  const out = new Uint8ClampedArray(d);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const idx = y * sw + x;
      if (!mask[idx]) continue;
      let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
      for (let rad = 2; rad <= 10 && cnt < 4; rad += 2) {
        const pts = [
          [x - rad, y], [x + rad, y], [x, y - rad], [x, y + rad],
          [x - rad, y - rad], [x + rad, y + rad], [x - rad, y + rad], [x + rad, y - rad]
        ];
        for (const [nx, ny] of pts) {
          if (nx < 0 || nx >= sw || ny < 0 || ny >= sh) continue;
          const nIdx = ny * sw + nx;
          if (!mask[nIdx]) {
            const np = nIdx * 4;
            rSum += d[np]; gSum += d[np + 1]; bSum += d[np + 2];
            cnt++;
          }
        }
      }
      const p = idx * 4;
      if (cnt > 0) {
        out[p] = Math.round(rSum / cnt);
        out[p + 1] = Math.round(gSum / cnt);
        out[p + 2] = Math.round(bSum / cnt);
      } else {
        out[p] = out[p + 1] = out[p + 2] = 255;
      }
      out[p + 3] = 255;
    }
  }

  img.data.set(out);
  pctx.putImageData(img, 0, 0);
  return patch;
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
    const pre = preprocessForOcr(crop);
    const { data } = await w.recognize(pre);
    pre.width = pre.height = 0;

    const text = (data.text || '').trim().replace(/\n{2,}/g, '\n');
    const lines = (data.lines || []).filter(l => l.text && l.text.trim());

    let estLineH = sel.h;
    if (lines.length) {
      const hs = lines.map(l => (l.bbox.y1 - l.bbox.y0) / full.height).filter(h => h > 0.004);
      if (hs.length) estLineH = hs.reduce((a, b) => a + b, 0) / hs.length;
    }

    const words = [];
    for (const ln of lines) {
      for (const wd of (ln.words || [])) {
        if (!wd.text || !wd.text.trim()) continue;
        words.push({ t: wd.text.trim(), x: (sx + wd.bbox.x0) / full.width, w: (wd.bbox.x1 - wd.bbox.x0) / full.width, c: wd.confidence });
      }
    }
    const lineGeo = lines.map(l => ({
      x: (sx + l.bbox.x0) / full.width, y: (sy + l.bbox.y0) / full.height,
      w: (l.bbox.x1 - l.bbox.x0) / full.width, h: (l.bbox.y1 - l.bbox.y0) / full.height,
      words: (l.words || []).filter(wd => wd.text && wd.text.trim()).map(wd => ({
        t: wd.text.trim(), x: (sx + wd.bbox.x0) / full.width,
        w: (wd.bbox.x1 - wd.bbox.x0) / full.width, c: wd.confidence
      }))
    }));

    openFloatingOcrEditor(pg, { text, x: sel.x, y: sel.y, w: sel.w, h: sel.h, lineH: estLineH, inkHex, words, lines: lineGeo }, R);
  } catch (err) {
    console.error(err);
    toast('Bölge okunamadı: ' + err.message, true);
  } finally {
    full.width = 0; full.height = 0;
    crop.width = 0; crop.height = 0;
  }
}

/* ---------- Zengin Metin (HTML <-> Runs) Yardımcıları ---------- */
function runsToHtml(runs) {
  const escH = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return runs.map(r => {
    let h = escH(r.t);
    if (r.b) h = `<b>${h}</b>`;
    if (r.i) h = `<i>${h}</i>`;
    if (r.c) h = `<span style="color:${r.c}">${h}</span>`;
    return h;
  }).join('');
}

function domToRuns(rootEl, baseBold, baseItalic, baseColor) {
  const out = [];
  const pushRun = (t, b, i, c) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.b === b && prev.i === i && prev.c === c) prev.t += t;
    else out.push({ t, b, i, c });
  };
  const walk = (node, b, i, c) => {
    if (node.nodeType === 3) {
      pushRun(node.nodeValue, b, i, c);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (tag === 'BR') { pushRun('\n', b, i, c); return; }
    let nb = b, ni = i, nc = c;
    if (tag === 'B' || tag === 'STRONG') nb = true;
    if (tag === 'I' || tag === 'EM') ni = true;
    const fw = node.style && node.style.fontWeight;
    if (fw === 'bold' || Number(fw) >= 600) nb = true;
    else if (fw === 'normal' || fw === '400') nb = false;
    const fs = node.style && node.style.fontStyle;
    if (fs === 'italic') ni = true;
    else if (fs === 'normal') ni = false;
    if (node.style && node.style.color) nc = node.style.color;
    const isBlock = (tag === 'DIV' || tag === 'P') && node !== rootEl;
    if (isBlock && out.length && !out[out.length - 1].t.endsWith('\n')) pushRun('\n', b, i, c);
    for (const ch of node.childNodes) walk(ch, nb, ni, nc);
  };
  walk(rootEl, !!baseBold, !!baseItalic, baseColor);
  return out;
}

/* ---------- Sağ Panel ve Çoklu Blok Taslak Yönetimi ---------- */
let activeEditor = null;

function toggleEditPanel(show) {
  const panel = document.getElementById('editPanel');
  if (!panel) return;
  panel.hidden = !show;
  document.body.classList.toggle('panel-open', !!show);
  if (show) initEditPanelOnce();
  refreshEditPanelUI();
}

let panelBound = false;
function initEditPanelOnce() {
  if (panelBound) return;
  panelBound = true;

  document.querySelectorAll('#epAlignRow [data-al]').forEach(b => {
    b.innerHTML = alignIcon(b.dataset.al);
    b.onclick = () => {
      if (!activeEditor) return;
      activeEditor.state.align = b.dataset.al;
      activeEditor.sync(true);
      refreshEditPanelUI();
    };
  });
  const btnIn = document.getElementById('epIn');
  if (btnIn) {
    btnIn.innerHTML = indentIcon();
    btnIn.onclick = () => {
      if (!activeEditor) return;
      const st = activeEditor.state;
      st.indentPt = (st.indentPt || 0) > 0.5 ? 0 : Math.round(st.fontPx * 2);
      activeEditor.sync(true);
      refreshEditPanelUI();
    };
  }

  const bind = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, () => { if (activeEditor) { fn(el); activeEditor.sync(true); refreshEditPanelUI(); } });
  };
  bind('epFont', 'change', el => { activeEditor.state.font = el.value; });
  bind('epSz', 'input', el => { activeEditor.state.fontPx = Math.max(6, Number(el.value) || 12); });
  bind('epLh', 'input', el => { activeEditor.state.lh = Math.max(0.9, Math.min(3, Number(el.value) || 1.25)); });
  bind('epFg', 'input', el => { activeEditor.setColor(el.value); });
  bind('epBg', 'input', el => { activeEditor.state.bg = el.value; activeEditor.state.keepWm = false; $('#bgColor').value = el.value; });
  bind('epWm', 'change', el => { activeEditor.state.keepWm = el.checked; });

  ['epB', 'epI'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('click', () => {
      if (!activeEditor) return;
      activeEditor.toggleStyle(id === 'epB' ? 'bold' : 'italic');
    });
  });

  document.getElementById('epApplyAll')?.addEventListener('click', () => commitAllDrafts());
  document.getElementById('epDiscard')?.addEventListener('click', () => discardAllDrafts());
}

function refreshEditPanelUI() {
  const body = document.getElementById('epControls');
  const badge = document.getElementById('epBadge');
  const cntEl = document.getElementById('epCount');
  const btnApply = document.getElementById('epApplyAll');
  const btnDiscard = document.getElementById('epDiscard');
  if (!body) return;

  const totalDrafts = S.drafts ? S.drafts.size : 0;
  if (cntEl) cntEl.textContent = totalDrafts ? `${totalDrafts} blokta değişiklik var` : 'Henüz değişiklik yok';
  if (btnApply) btnApply.disabled = totalDrafts === 0;
  if (btnDiscard) btnDiscard.disabled = totalDrafts === 0 && !activeEditor;

  if (!activeEditor) {
    body.classList.add('disabled');
    if (badge) badge.textContent = 'Blok seçin';
    return;
  }

  body.classList.remove('disabled');
  if (badge) badge.textContent = 'Seçili metin';
  const st = activeEditor.state;

  const fontSel = document.getElementById('epFont');
  if (fontSel) fillFontSelect(fontSel, st.font);
  const sz = document.getElementById('epSz');
  if (sz && document.activeElement !== sz) sz.value = st.fontPx;
  const lh = document.getElementById('epLh');
  if (lh && document.activeElement !== lh) lh.value = Number(st.lh).toFixed(2);

  const fg = document.getElementById('epFg');
  if (fg) fg.value = st.color;
  const fgHex = document.getElementById('epFgHex');
  if (fgHex) fgHex.textContent = st.color;

  const bg = document.getElementById('epBg');
  if (bg) bg.value = st.bg;
  const bgHex = document.getElementById('epBgHex');
  if (bgHex) bgHex.textContent = st.bg;

  const wm = document.getElementById('epWm');
  if (wm) wm.checked = !!st.keepWm;

  document.getElementById('epB')?.classList.toggle('active', !!st.bold);
  document.getElementById('epI')?.classList.toggle('active', !!st.italic);
  document.querySelectorAll('#epAlignRow [data-al]').forEach(b => b.classList.toggle('active', b.dataset.al === st.align));
  document.getElementById('epIn')?.classList.toggle('active', (st.indentPt || 0) > 0.5);
}

function parkActiveEditor() {
  if (!activeEditor) return;
  activeEditor.park();
  activeEditor = null;
  refreshEditPanelUI();
}

function commitAllDrafts() {
  parkActiveEditor();
  if (!S.drafts || !S.drafts.size) return;

  const items = [...S.drafts.values()];
  const undoList = [];
  const touchedPages = new Set();

  for (const d of items) {
    const { pg, box, state, newRaw, shapes: added } = d;
    const prevApplied = box.appliedShapes || [];
    const prevState = {
      text: box.text, x: box.x, y: box.y, w: box.w, h: box.h,
      fontPx: box.lastFontPx, font: box.lastFont,
      bold: box.lastBold, italic: box.lastItalic, color: box.lastColor, bg: box.lastBg,
      keepWm: box.lastKeepWm, align: box.lastAlign, indent: box.lastIndent, lh: box.lastLh,
      runs: box.lastRuns
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
    box.lastKeepWm = state.keepWm;
    box.lastAlign = state.align;
    box.lastIndent = state.indentPt;
    box.lastLh = state.lh;
    box.lastRuns = state.runs ? state.runs.map(r => ({ ...r })) : null;
    box.appliedShapes = added;
    pg.shapes.push(...added);
    touchedPages.add(pg);

    undoList.push({ pg, box, added, prevApplied, prevState });
  }

  S.drafts.clear();
  push(() => {
    for (const u of undoList) {
      for (const s of u.added) {
        const idx = u.pg.shapes.indexOf(s);
        if (idx >= 0) u.pg.shapes.splice(idx, 1);
      }
      u.pg.shapes.push(...u.prevApplied);
      u.box.appliedShapes = u.prevApplied;
      u.box.text = u.prevState.text;
      u.box.x = u.prevState.x; u.box.y = u.prevState.y; u.box.w = u.prevState.w; u.box.h = u.prevState.h;
      u.box.lastFontPx = u.prevState.fontPx;
      u.box.lastFont = u.prevState.font;
      u.box.lastBold = u.prevState.bold;
      u.box.lastItalic = u.prevState.italic;
      u.box.lastColor = u.prevState.color;
      u.box.lastBg = u.prevState.bg;
      u.box.lastKeepWm = u.prevState.keepWm;
      u.box.lastAlign = u.prevState.align;
      u.box.lastIndent = u.prevState.indent;
      u.box.lastLh = u.prevState.lh;
      u.box.lastRuns = u.prevState.runs;
    }
  });

  touchedPages.forEach(paint);
  refreshEditPanelUI();
  toast(`${items.length} blok uygulandı.`);
}

function discardAllDrafts() {
  if (activeEditor) {
    activeEditor.destroyOnly();
    activeEditor = null;
  }
  const touched = new Set();
  if (S.drafts) {
    for (const d of S.drafts.values()) touched.add(d.pg);
    S.drafts.clear();
  }
  touched.forEach(p => { p.editingHide = null; paint(p); });
  refreshEditPanelUI();
  toast('Değişiklikler iptal edildi.');
}

async function openFloatingOcrEditor(pg, box, R) {
  parkActiveEditor();
  toggleEditPanel(true);

  const sheet = pg.ov.parentElement;
  const sw = sheet.clientWidth;
  const sh = sheet.clientHeight;
  const rw = R % 180 ? sh : sw;

  const existingDraft = S.drafts.get(box);
  const prevApplied = box.appliedShapes || [];
  pg.editingHide = prevApplied;

  let state, origRawBox, curRawBox, initStateSnap, movedOrResized = false;

  if (existingDraft) {
    state = { ...existingDraft.state, runs: existingDraft.state.runs.map(r => ({ ...r })) };
    origRawBox = { ...existingDraft.origRawBox };
    curRawBox = { ...existingDraft.newRaw };
    initStateSnap = existingDraft.initStateSnap;
    movedOrResized = !!existingDraft.movedOrResized;
    existingDraft.isActive = true;
  } else {
    const detectedBg = sampleBgColor(pg, box, R);
    $('#bgColor').value = detectedBg;
    const fallbackColor = isDarkColor(detectedBg) ? '#ffffff' : '#111111';
    const initColor = box.inkHex || fallbackColor;
    const detectedStyle = await detectPdfTextStyle(pg, box);

    const estOcrPt = Math.max(8, Math.min(36, Math.round(box.lineH * pg.h * 0.78 * 2) / 2));
    const initFontPx = box.lastFontPx || detectedStyle.fontPx || estOcrPt;
    const initAlign = box.lastAlign || detectedStyle.align || 'left';
    const initIndent = box.lastIndent ?? detectedStyle.indentPt ?? 0;
    const initLh = box.lastLh || (detectedStyle.pitchPt
      ? Math.max(1.0, Math.min(2.6, detectedStyle.pitchPt / initFontPx)) : 1.25);
    const initBold = box.lastBold ?? detectedStyle.bold;
    const initItalic = box.lastItalic ?? detectedStyle.italic;
    const initFg = box.lastColor || initColor;

    state = {
      text: box.text,
      fontPx: initFontPx,
      font: box.lastFont || detectedStyle.font,
      bold: initBold,
      italic: initItalic,
      color: initFg,
      bg: box.lastBg || detectedBg,
      keepWm: box.lastKeepWm ?? false,
      align: initAlign,
      indentPt: initIndent,
      lh: initLh,
      runs: box.lastRuns
        ? box.lastRuns.map(r => ({ ...r }))
        : [{ t: box.text, b: initBold, i: initItalic, c: initFg }]
    };
    origRawBox = { x: box.x, y: box.y, w: box.w, h: box.h };
    curRawBox = { ...origRawBox };
    initStateSnap = JSON.stringify(state);
  }

  const [sx0, sy0] = fromRaw(R, curRawBox.x, curRawBox.y);
  const [sx1, sy1] = fromRaw(R, curRawBox.x + curRawBox.w, curRawBox.y + curRawBox.h);
  const rect = {
    left: Math.min(sx0, sx1) * sw,
    top: Math.min(sy0, sy1) * sh,
    width: Math.max(36, Math.abs(sx1 - sx0) * sw),
    height: Math.max(16, Math.abs(sy1 - sy0) * sh)
  };

  const wrap = document.createElement('div');
  wrap.className = 'inline-ocr-wrap';

  const dragHandle = document.createElement('div');
  dragHandle.className = 'ocr-drag';
  dragHandle.title = 'Kutuyu taşımak için sürükleyin';
  dragHandle.textContent = '✥';
  wrap.appendChild(dragHandle);

  const ta = document.createElement('div');
  ta.className = 'inline-ocr-editor';
  ta.contentEditable = 'true';
  ta.spellcheck = false;
  ta.innerHTML = runsToHtml(state.runs);
  wrap.appendChild(ta);

  const mini = document.createElement('div');
  mini.className = 'mini-bar';
  mini.innerHTML = `
    <button type="button" id="mbB" title="Kalın"><b>B</b></button>
    <button type="button" id="mbI" title="İtalik"><i>I</i></button>
    <span class="mb-sep"></span>
    <button type="button" id="mbSm" title="Küçült">A−</button>
    <button type="button" id="mbLg" title="Büyüt">A+</button>
    <span class="mb-sep"></span>
    <input type="color" id="mbFg" value="${state.color}" title="Yazı rengi">
  `;
  mini.addEventListener('mousedown', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); });

  const applyRect = () => {
    wrap.style.left = rect.left + 'px';
    wrap.style.top = rect.top + 'px';
    wrap.style.width = rect.width + 'px';
    wrap.style.height = rect.height + 'px';
    const mw = mini.offsetWidth || 180;
    mini.style.left = Math.max(4, Math.min(sw - mw - 4, rect.left + 32)) + 'px';
    mini.style.top = (rect.top > 44 ? rect.top - 40 : rect.top + rect.height + 8) + 'px';
  };

  dragHandle.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    dragHandle.setPointerCapture(e.pointerId);
    const startX = e.clientX, startY = e.clientY, origL = rect.left, origT = rect.top;
    const mv = ev => {
      rect.left = Math.max(0, Math.min(sw - rect.width, origL + (ev.clientX - startX)));
      rect.top = Math.max(0, Math.min(sh - rect.height, origT + (ev.clientY - startY)));
      movedOrResized = true;
      applyRect();
      saveToDraft(true);
    };
    const up = () => {
      dragHandle.removeEventListener('pointermove', mv);
      dragHandle.removeEventListener('pointerup', up);
      dragHandle.removeEventListener('pointercancel', up);
    };
    dragHandle.addEventListener('pointermove', mv);
    dragHandle.addEventListener('pointerup', up);
    dragHandle.addEventListener('pointercancel', up);
  });

  ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'].forEach(dir => {
    const h = document.createElement('div');
    h.className = `ocr-h ${dir}`;
    h.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const startX = e.clientX, startY = e.clientY, orig = { ...rect };
      const minW = 28, minH = 14;
      const mv = ev => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        if (dir.includes('e')) rect.width = Math.max(minW, Math.min(sw - orig.left, orig.width + dx));
        if (dir.includes('w')) {
          const nl = Math.max(0, Math.min(orig.left + orig.width - minW, orig.left + dx));
          rect.width = orig.width + (orig.left - nl); rect.left = nl;
        }
        if (dir.includes('s')) rect.height = Math.max(minH, Math.min(sh - orig.top, orig.height + dy));
        if (dir.includes('n')) {
          const nt = Math.max(0, Math.min(orig.top + orig.height - minH, orig.top + dy));
          rect.height = orig.height + (orig.top - nt); rect.top = nt;
        }
        movedOrResized = true;
        applyRect();
        saveToDraft(true);
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
  sheet.appendChild(mini);
  applyRect();

  const getRawBox = () => {
    if (!movedOrResized) return { ...curRawBox };
    const [rx0, ry0] = toRaw(R, rect.left / sw, rect.top / sh);
    const [rx1, ry1] = toRaw(R, (rect.left + rect.width) / sw, (rect.top + rect.height) / sh);
    return { x: Math.min(rx0, rx1), y: Math.min(ry0, ry1), w: Math.abs(rx1 - rx0), h: Math.abs(ry1 - ry0) };
  };

  const buildShapes = newRaw => {
    const padX = 0.002, padY = 0.002;
    const coverBox = {
      x: Math.max(0, origRawBox.x - padX), y: Math.max(0, origRawBox.y - padY),
      w: origRawBox.w + padX * 2, h: origRawBox.h + padY * 2
    };
    const out = [];
    if (state.keepWm) {
      const patchCanvas = createWatermarkSafePatch(pg, coverBox, R);
      out.push(patchCanvas ? { t: 'patch', canvas: patchCanvas, ...coverBox } : { t: 'white', c: state.bg, ...coverBox });
    } else {
      out.push({ t: 'white', c: state.bg, ...coverBox });
    }
    if (state.text.trim()) {
      out.push({
        t: 'text', c: state.color, x: newRaw.x, y: newRaw.y, maxW: newRaw.w,
        s: state.text, runs: state.runs.map(r => ({ ...r })),
        size: state.fontPx / pg.w, font: state.font,
        bold: state.bold, italic: state.italic, lh: state.lh,
        align: state.align, indent: (state.indentPt || 0) / pg.w
      });
    }
    return out;
  };

  const saveToDraft = (isActive) => {
    const changed = movedOrResized || JSON.stringify(state) !== initStateSnap;
    if (changed) {
      const newRaw = getRawBox();
      const shapesArr = isActive ? null : buildShapes(newRaw);
      S.drafts.set(box, {
        pg, box, state: { ...state, runs: state.runs.map(r => ({ ...r })) },
        origRawBox, newRaw, initStateSnap, movedOrResized, isActive,
        shapes: shapesArr, previewShapes: shapesArr
      });
    } else {
      S.drafts.delete(box);
    }
    refreshEditPanelUI();
  };

  const sync = (autoGrow = true) => {
    const px = (state.fontPx / pg.w) * rw;
    ta.style.fontFamily = state.font;
    ta.style.fontSize = px + 'px';
    ta.style.textAlign = state.align;
    ta.style.textIndent = ((state.indentPt || 0) / pg.w * rw) + 'px';
    ta.style.lineHeight = String(state.lh);
    ta.style.color = state.color;
    ta.style.backgroundColor = state.keepWm ? 'rgba(255,255,255,0.88)' : state.bg;
    mini.querySelector('#mbB').classList.toggle('active', !!state.bold);
    mini.querySelector('#mbI').classList.toggle('active', !!state.italic);
    mini.querySelector('#mbFg').value = state.color;
    if (autoGrow && ta.scrollHeight > rect.height) {
      rect.height = Math.min(sh - rect.top, ta.scrollHeight + 2);
      movedOrResized = true;
      applyRect();
    }
    saveToDraft(true);
  };

  const toggleStyle = cmd => {
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && ta.contains(sel.anchorNode) && ta.contains(sel.focusNode);
    if (hasSel) {
      document.execCommand(cmd, false, null);
      state.runs = domToRuns(ta, state.bold, state.italic, state.color);
      state.text = state.runs.map(r => r.t).join('');
      sync(true);
    } else {
      if (cmd === 'bold') state.bold = !state.bold;
      else state.italic = !state.italic;
      state.runs = state.runs.map(r => ({ ...r, [cmd === 'bold' ? 'b' : 'i']: cmd === 'bold' ? state.bold : state.italic }));
      ta.innerHTML = runsToHtml(state.runs);
      sync(true);
    }
    refreshEditPanelUI();
  };

  const setColor = hex => {
    state.color = hex;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && ta.contains(sel.anchorNode) && ta.contains(sel.focusNode);
    if (hasSel) {
      document.execCommand('foreColor', false, hex);
      state.runs = domToRuns(ta, state.bold, state.italic, state.color);
    } else {
      state.runs = state.runs.map(r => ({ ...r, c: hex }));
      ta.innerHTML = runsToHtml(state.runs);
    }
    sync(false);
  };

  ta.oninput = () => {
    state.runs = domToRuns(ta, state.bold, state.italic, state.color);
    state.text = state.runs.map(r => r.t).join('');
    sync(true);
  };

  mini.querySelector('#mbB').onclick = () => toggleStyle('bold');
  mini.querySelector('#mbI').onclick = () => toggleStyle('italic');
  mini.querySelector('#mbSm').onclick = () => { state.fontPx = Math.max(6, +(state.fontPx - 0.5).toFixed(1)); sync(true); ta.focus(); };
  mini.querySelector('#mbLg').onclick = () => { state.fontPx = Math.min(120, +(state.fontPx + 0.5).toFixed(1)); sync(true); ta.focus(); };
  mini.querySelector('#mbFg').oninput = e => setColor(e.target.value);

  ta.onkeydown = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); parkActiveEditor(); }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); commitAllDrafts(); }
  };

  const destroyOnly = () => {
    if (wrap.parentNode) wrap.remove();
    if (mini.parentNode) mini.remove();
    pg.editingHide = null;
  };

  activeEditor = {
    state,
    sync,
    toggleStyle,
    setColor,
    destroyOnly,
    park() {
      saveToDraft(false);
      destroyOnly();
      paint(pg);
    }
  };

  S.closeEditor = cancel => {
    if (cancel) discardAllDrafts();
    else commitAllDrafts();
  };

  paint(pg);
  sync(false);
  applyRect();
  refreshEditPanelUI();
  ta.focus();
}

function alignIcon(type) {
  const rows = {
    left:    [[1, 13], [1, 9], [1, 13], [1, 7]],
    center:  [[1, 13], [3, 11], [1, 13], [4, 10]],
    right:   [[1, 13], [5, 13], [1, 13], [7, 13]],
    justify: [[1, 13], [1, 13], [1, 13], [1, 13]]
  }[type];
  const ln = rows.map(([a, b], i) => `<line x1="${a}" y1="${2.5 + i * 3}" x2="${b}" y2="${2.5 + i * 3}"/>`).join('');
  return `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">${ln}</svg>`;
}

function indentIcon() {
  return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
    '<line x1="5" y1="2.5" x2="13" y2="2.5"/><line x1="1" y1="5.5" x2="13" y2="5.5"/>' +
    '<line x1="1" y1="8.5" x2="13" y2="8.5"/><line x1="1" y1="11.5" x2="8" y2="11.5"/></svg>';
}

function fillFontSelect(sel, currentCss) {
  const cur = primaryFamily(currentCss).toLowerCase();
  sel.textContent = '';
  let found = false;
  const add = (value, label) => {
    const op = document.createElement('option');
    op.value = value;
    op.textContent = label;
    if (!found && primaryFamily(value).toLowerCase() === cur) { op.selected = true; found = true; }
    sel.appendChild(op);
  };

  if (SysFonts.families.length) {
    const hasCur = SysFonts.families.some(f => f.toLowerCase() === cur);
    if (!hasCur) {
      const legacy = FONT_OPTIONS.find(x => primaryFamily(x.value).toLowerCase() === cur);
      add(currentCss, legacy ? legacy.label : primaryFamily(currentCss));
    }
    SysFonts.families.forEach(f => add(fontCss(f), f));
  } else {
    FONT_OPTIONS.forEach(x => add(x.value, x.label));
  }

  if (!found && sel.options.length) sel.selectedIndex = 0;
}

document.getElementById('btnEdit')?.addEventListener('click', () => { initSystemFonts(); });

function isDarkColor(hex) {
  const c = hex.substring(1), rgb = parseInt(c, 16);
  return (0.2126 * ((rgb >> 16) & 255) + 0.7152 * ((rgb >> 8) & 255) + 0.0722 * (rgb & 255)) < 128;
}