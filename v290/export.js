/* ---------- PDF → Word / Excel (Hibrit: Dijital Metin + OCR + Tablo Algılama) ----------
   Harici kütüphane gerektirmez: .docx ve .xlsx dosyaları doğrudan OOXML olarak üretilir.
   Akış: sayfayı çiz → çizgileri (tablo kenarlıkları) bul → dijital metin varsa doğrudan al,
         yoksa çizgileri silip OCR uygula → hücre/paragraf/stil çözümle → Word ve Excel üret.
------------------------------------------------------------------------------------------ */
(function (root) {
  'use strict';

  const median = a => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const mean = a => a.reduce((s, v) => s + v, 0) / (a.length || 1);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const normTr = s => String(s == null ? '' : s)
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/g, '')
    .normalize('NFC');
  const esc = s => normTr(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /* ======================================================================
     0) Bilgisayardaki Türkçe Destekli Font Seçimi
     ====================================================================== */
  const trFontCache = new Map();

  function supportsTurkishFont(family) {
    if (!family) return false;
    const key = String(family).trim();
    if (!key) return false;
    if (trFontCache.has(key)) return trFontCache.get(key);
    try {
      const c = document.createElement('canvas');
      c.width = 240; c.height = 32;
      const ctx = c.getContext('2d');
      const trChars = 'ĞŞİıÇÖÜğşçöü';
      const probe = 'mmmmlliW' + trChars;

      // 1) Fontun bilgisayarda kurulu olduğunu doğrula
      ctx.font = `20px "${key}", monospace`;
      const wMono = ctx.measureText(probe).width;
      ctx.font = '20px monospace';
      const wBaseMono = ctx.measureText(probe).width;
      ctx.font = `20px "${key}", serif`;
      const wSerif = ctx.measureText(probe).width;
      ctx.font = '20px serif';
      const wBaseSerif = ctx.measureText(probe).width;
      const installed = (Math.abs(wMono - wBaseMono) > 0.5) || (Math.abs(wSerif - wBaseSerif) > 0.5);
      if (!installed) { trFontCache.set(key, false); return false; }

      // 2) Türkçe karakterlerde yedek fonta düşüp düşmediğini kontrol et
      ctx.font = `20px "${key}", monospace`;
      const trA = ctx.measureText(trChars).width;
      ctx.font = `20px "${key}", serif`;
      const trB = ctx.measureText(trChars).width;
      const ok = trA > 0 && Math.abs(trA - trB) < 0.5;
      trFontCache.set(key, ok);
      return ok;
    } catch (_) {
      return false;
    }
  }

  function pickSafeTurkishFont(family, infoHint = '') {
    if (family && supportsTurkishFont(family)) return family;
    const hint = `${family || ''} ${infoHint}`.toLowerCase();
    const isMono = /mono|courier|consolas|menlo|fixed/.test(hint);
    const isSerif = /times|serif|cambria|georgia|garamond|palatino|book|century/.test(hint) && !/sans/.test(hint);

    const candidates = isMono
      ? ['Consolas', 'Courier New', 'DejaVu Sans Mono', 'Liberation Mono']
      : isSerif
        ? ['Times New Roman', 'Cambria', 'Georgia', 'DejaVu Serif', 'Liberation Serif']
        : ['Calibri', 'Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'DejaVu Sans', 'Liberation Sans'];

    const installed = (typeof SysFonts !== 'undefined' && SysFonts && Array.isArray(SysFonts.families))
      ? SysFonts.families : [];

    for (const c of candidates) {
      if (installed.some(f => f.toLowerCase() === c.toLowerCase()) && supportsTurkishFont(c)) return c;
    }
    for (const c of candidates) {
      if (supportsTurkishFont(c)) return c;
    }
    return isMono ? 'Courier New' : isSerif ? 'Times New Roman' : 'Arial';
  }

  /* ======================================================================
     1) ZIP yazıcı (deflate-raw destekliyse sıkıştırır, yoksa saklar)
     ====================================================================== */
  const CRC_T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(b) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const w = cs.writable.getWriter();
      w.write(bytes); w.close();
      return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    } catch (_) { return null; }
  }

  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const u16 = v => [v & 255, (v >> 8) & 255];
    const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const date = ((2026 - 1980) << 9) | (1 << 5) | 1;

    for (const f of files) {
      const name = enc.encode(f.name);
      const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(raw);
      let comp = await deflateRaw(raw), method = 8;
      if (!comp || comp.length >= raw.length) { comp = raw; method = 0; }

      const lh = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(date),
        ...u32(crc), ...u32(comp.length), ...u32(raw.length), ...u16(name.length), ...u16(0)
      ]);
      parts.push(lh, name, comp);
      central.push(new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(method), ...u16(0), ...u16(date),
        ...u32(crc), ...u32(comp.length), ...u32(raw.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset)
      ]), name);
      offset += lh.length + name.length + comp.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(cdSize), ...u32(offset), ...u16(0)
    ]);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0;
    for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  /* ======================================================================
     2) Çizgi (tablo kenarlığı) algılama – ham piksel dizisi üzerinde
     ====================================================================== */
  function buildDark(rgba, cw, ch, thr = 175) {
    const d = new Uint8Array(cw * ch);
    for (let i = 0, p = 0; i < d.length; i++, p += 4) {
      d[i] = ((rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000) < thr ? 1 : 0;
    }
    return d;
  }

  function detectRuling(dark, cw, ch, opt = {}) {
    const minH = opt.minH || Math.max(24, Math.round(cw * 0.02));
    const minV = opt.minV || Math.max(24, Math.round(ch * 0.015));
    const maxTh = opt.maxTh || Math.max(8, Math.round(Math.min(cw, ch) * 0.012));
    const gapTol = 2;

    const hSegs = [];
    let open = [];
    for (let y = 0; y < ch; y++) {
      const row = y * cw;
      const runs = [];
      let x = 0;
      while (x < cw) {
        if (!dark[row + x]) { x++; continue; }
        const x0 = x;
        let last = x, miss = 0;
        while (x < cw) {
          if (dark[row + x]) { last = x; miss = 0; } else if (++miss > gapTol) break;
          x++;
        }
        if (last - x0 + 1 >= minH) runs.push([x0, last]);
        x = last + 1;
      }
      const next = [];
      const used = new Set();
      for (const [a, b] of runs) {
        let hit = null;
        for (const sg of open) {
          if (used.has(sg) || sg.y1 < y - 2) continue;
          const ov = Math.min(b, sg.x1) - Math.max(a, sg.x0);
          if (ov >= 0.7 * Math.min(b - a, sg.x1 - sg.x0)) { hit = sg; break; }
        }
        if (hit) { used.add(hit); hit.y1 = y; hit.x0 = Math.min(hit.x0, a); hit.x1 = Math.max(hit.x1, b); next.push(hit); }
        else next.push({ x0: a, x1: b, y0: y, y1: y });
      }
      for (const sg of open) if (!used.has(sg) && sg.y1 >= y - 2) next.push(sg);
      for (const sg of open) if (!used.has(sg) && sg.y1 < y - 2) hSegs.push(sg);
      open = next;
    }
    hSegs.push(...open);

    const active = new Uint8Array(cw), miss = new Uint8Array(cw);
    const start = new Int32Array(cw), lastOn = new Int32Array(cw);
    const vRaw = [];
    for (let y = 0; y <= ch; y++) {
      const row = y * cw;
      for (let x = 0; x < cw; x++) {
        const on = y < ch && dark[row + x] === 1;
        if (on) {
          if (!active[x]) { active[x] = 1; start[x] = y; }
          lastOn[x] = y; miss[x] = 0;
        } else if (active[x]) {
          miss[x]++;
          if (miss[x] > gapTol || y === ch) {
            if (lastOn[x] - start[x] + 1 >= minV) vRaw.push({ x, y0: start[x], y1: lastOn[x] });
            active[x] = 0; miss[x] = 0;
          }
        }
      }
    }
    vRaw.sort((a, b) => a.x - b.x || a.y0 - b.y0);
    const vSegs = [];
    let vOpen = [];
    for (const r of vRaw) {
      vOpen = vOpen.filter(s => r.x - s.x1 <= 1);
      let hit = null;
      for (const s of vOpen) {
        const ov = Math.min(r.y1, s.y1) - Math.max(r.y0, s.y0);
        if (ov >= 0.7 * Math.min(r.y1 - r.y0, s.y1 - s.y0)) { hit = s; break; }
      }
      if (hit) { hit.x1 = r.x; hit.y0 = Math.min(hit.y0, r.y0); hit.y1 = Math.max(hit.y1, r.y1); }
      else { const s = { x0: r.x, x1: r.x, y0: r.y0, y1: r.y1 }; vSegs.push(s); vOpen.push(s); }
    }

    return {
      h: hSegs.filter(s => s.y1 - s.y0 + 1 <= maxTh).map(s => ({ x0: s.x0, x1: s.x1, y: (s.y0 + s.y1) / 2, th: s.y1 - s.y0 + 1 })),
      v: vSegs.filter(s => s.x1 - s.x0 + 1 <= maxTh).map(s => ({ x: (s.x0 + s.x1) / 2, y0: s.y0, y1: s.y1, th: s.x1 - s.x0 + 1 }))
    };
  }

  function clusterPos(vals, tol) {
    const s = [...vals].sort((a, b) => a - b);
    const out = [];
    let g = [];
    for (const v of s) {
      if (g.length && v - g[g.length - 1] > tol) { out.push(mean(g)); g = []; }
      g.push(v);
    }
    if (g.length) out.push(mean(g));
    return out;
  }

  function coverFrac(intervals, a, b) {
    if (b <= a) return 0;
    const iv = intervals.map(([s, e]) => [Math.max(a, s), Math.min(b, e)]).filter(([s, e]) => e > s).sort((p, q) => p[0] - q[0]);
    let tot = 0, cs = null, ce = null;
    for (const [s, e] of iv) {
      if (cs === null) { cs = s; ce = e; }
      else if (s <= ce + 2) ce = Math.max(ce, e);
      else { tot += ce - cs; cs = s; ce = e; }
    }
    if (cs !== null) tot += ce - cs;
    return tot / (b - a);
  }

  function buildGridTable(hs, vs, o) {
    const tol = o.tol;
    let xs = clusterPos(vs.map(s => s.x), tol), ys = clusterPos(hs.map(s => s.y), tol);
    const hx0 = Math.min(...hs.map(s => s.x0)), hx1 = Math.max(...hs.map(s => s.x1));
    const vy0 = Math.min(...vs.map(s => s.y0)), vy1 = Math.max(...vs.map(s => s.y1));
    if (hx0 < xs[0] - tol) xs.unshift(hx0);
    if (hx1 > xs[xs.length - 1] + tol) xs.push(hx1);
    if (vy0 < ys[0] - tol) ys.unshift(vy0);
    if (vy1 > ys[ys.length - 1] + tol) ys.push(vy1);

    const thin = (arr, min) => {
      const out = [arr[0]];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] - out[out.length - 1] >= min) out.push(arr[i]);
        else if (i === arr.length - 1) out[out.length - 1] = arr[i];
      }
      return out;
    };
    xs = thin(xs, o.minGapX); ys = thin(ys, o.minGapY);
    if (xs.length < 2 || ys.length < 2) return null;

    const vIv = vs.map(s => ({ x: s.x, iv: [s.y0, s.y1] }));
    const hIv = hs.map(s => ({ y: s.y, iv: [s.x0, s.x1] }));
    const vCov = (x, y0, y1) => coverFrac(vIv.filter(s => Math.abs(s.x - x) <= tol * 1.5).map(s => s.iv), y0, y1);
    const hCov = (y, x0, x1) => coverFrac(hIv.filter(s => Math.abs(s.y - y) <= tol * 1.5).map(s => s.iv), x0, x1);
    const vb = (r, c) => vCov(xs[c], ys[r], ys[r + 1]) >= 0.55;
    const hb = (r, c) => hCov(ys[r], xs[c], xs[c + 1]) >= 0.55;

    const R = ys.length - 1, C = xs.length - 1;
    const owner = Array.from({ length: R }, () => Array(C).fill(-1));
    const cells = [];
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (owner[r][c] >= 0) continue;
        let cs = 1;
        while (c + cs < C && owner[r][c + cs] < 0 && !vb(r, c + cs)) cs++;
        let rs = 1;
        while (r + rs < R) {
          let ok = true;
          for (let cc = c; cc < c + cs && ok; cc++) {
            if (owner[r + rs][cc] >= 0 || hb(r + rs, cc)) ok = false;
          }
          for (let cc = c + 1; cc < c + cs && ok; cc++) if (vb(r + rs, cc)) ok = false;
          if (!ok) break;
          rs++;
        }
        const idx = cells.length;
        cells.push({ r, c, rs, cs });
        for (let rr = r; rr < r + rs; rr++) for (let cc = c; cc < c + cs; cc++) owner[rr][cc] = idx;
      }
    }
    return { xs, ys, cells, owner, R, C, bordered: true };
  }

  function findGridTables(ruling, o) {
    const items = [...ruling.h.map(s => ({ k: 'h', s })), ...ruling.v.map(s => ({ k: 'v', s }))];
    const par = items.map((_, i) => i);
    const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const tol = o.tol;
    for (let i = 0; i < items.length; i++) {
      if (items[i].k !== 'h') continue;
      const h = items[i].s;
      for (let j = 0; j < items.length; j++) {
        if (items[j].k !== 'v') continue;
        const v = items[j].s;
        if (v.x >= h.x0 - tol && v.x <= h.x1 + tol && h.y >= v.y0 - tol && h.y <= v.y1 + tol) {
          par[find(i)] = find(j);
        }
      }
    }
    const comps = new Map();
    items.forEach((it, i) => {
      const r = find(i);
      if (!comps.has(r)) comps.set(r, { hs: [], vs: [] });
      (it.k === 'h' ? comps.get(r).hs : comps.get(r).vs).push(it.s);
    });
    const tables = [];
    for (const cp of comps.values()) {
      if (cp.hs.length < 2 || cp.vs.length < 2) continue;
      const t = buildGridTable(cp.hs, cp.vs, o);
      if (t && t.R * t.C >= 2) tables.push(t);
    }
    return tables;
  }

  /* ======================================================================
     3) Gelişmiş Değer Ayrıştırıcı (Sayı, Para Birimi, Yüzde, Tarih)
     ====================================================================== */
  const NUM_TR = /^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/;
  const NUM_EN = /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

function parseTrNumber(t) {
    const s = String(t).trim();
    if (!NUM_TR.test(s)) return null;
    // 0.816 gibi "0." ile başlayan değerler binlik ayracı değil ondalık sayıdır
    if (/^[+-]?0\.\d+/.test(s)) return null;
    const digits = s.replace(/[^\d]/g, '');
    if (digits.length > 15) return null;
    if (/^[+-]?0\d/.test(s) && !/^[+-]?0,/.test(s)) return null;
    const dec = s.includes(',') ? s.split(',')[1].length : 0;
    return { v: parseFloat(s.replace(/\./g, '').replace(',', '.')), dec, thou: /\./.test(s.split(',')[0]) };
  }

  function parseExcelValue(rawText) {
    const s = normTr(rawText).trim();
    if (!s || s.includes('\n')) return { val: s, numFmt: 0 };

    // 1) Tarih: DD.MM.YYYY veya DD/MM/YYYY
    const dm = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
    if (dm) {
      const d = +dm[1], m = +dm[2], y = +dm[3];
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
        const utc = Date.UTC(y, m - 1, d);
        const dt = new Date(utc);
        if (dt.getUTCDate() === d && dt.getUTCMonth() === m - 1) {
          const serial = Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000);
          return { val: serial, numFmt: 168 };
        }
      }
    }

    // 2) Yüzde: %18,5 veya 18,5%
    const pm = s.match(/^%\s*([+-]?[\d.,]+)$/) || s.match(/^([+-]?[\d.,]+)\s*%$/);
    if (pm) {
      const n = parseTrNumber(pm[1]) || (NUM_EN.test(pm[1]) ? { v: parseFloat(pm[1].replace(/,/g, '')), dec: (pm[1].split('.')[1] || '').length } : null);
      if (n && Number.isFinite(n.v)) {
        return { val: n.v / 100, numFmt: n.dec > 0 ? 10 : 9 };
      }
    }

    // 3) Para birimi: ₺, TL, $, USD, €, EUR
    const curPatterns = [
      { re: /^(?:₺|TL)\s*([+-]?[\d.,]+)$|^([+-]?[\d.,]+)\s*(?:₺|TL)$/i, fmt: 164 },
      { re: /^(?:\$|USD)\s*([+-]?[\d.,]+)$|^([+-]?[\d.,]+)\s*(?:\$|USD)$/i, fmt: 165 },
      { re: /^(?:€|EUR)\s*([+-]?[\d.,]+)$|^([+-]?[\d.,]+)\s*(?:€|EUR)$/i, fmt: 166 }
    ];
    for (const cp of curPatterns) {
      const cm = s.match(cp.re);
      if (cm) {
        const numPart = cm[1] || cm[2];
        const n = parseTrNumber(numPart) || (NUM_EN.test(numPart) ? { v: parseFloat(numPart.replace(/,/g, '')) } : null);
        if (n && Number.isFinite(n.v)) return { val: n.v, numFmt: cp.fmt };
      }
    }

    // 4) 0.816 gibi nokta ile ayrılmış ondalık sayılar
    if (/^[+-]?0\.\d+$/.test(s)) {
      const v = parseFloat(s);
      if (Number.isFinite(v)) return { val: v, numFmt: 0 };
    }

    // 5) Düz Türkçe sayı
    const tr = parseTrNumber(s);
    if (tr && Number.isFinite(tr.v)) {
      const fmt = tr.dec === 2 ? (tr.thou ? 4 : 2) : (tr.dec === 0 && tr.thou ? 3 : 0);
      return { val: tr.v, numFmt: fmt };
    }

    return { val: s, numFmt: 0 };
  }

  /* ======================================================================
     4) Sayfa modeli: kelimeler → tablo hücreleri / paragraflar (karma stil destekli)
     ====================================================================== */
  const locate = (arr, v) => {
    let i = 0;
    while (i < arr.length - 2 && v >= arr[i + 1]) i++;
    return i;
  };

  function groupWordsToLines(words) {
    const ws = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const out = [];
    for (const w of ws) {
      const cy = (w.y0 + w.y1) / 2, h = w.y1 - w.y0;
      const last = out[out.length - 1];
      if (last && Math.abs(cy - last.cy) <= 0.6 * Math.min(h, last.h)) {
        last.words.push(w);
        last.cy = (last.cy * (last.words.length - 1) + cy) / last.words.length;
      } else out.push({ words: [w], cy, h });
    }
    out.forEach(l => l.words.sort((a, b) => a.x0 - b.x0));
    return out;
  }

  function buildRunsFromWords(words) {
    if (!words || !words.length) return [];
    const runs = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const b = !!w.bold, it = !!w.italic;
      const prev = runs[runs.length - 1];
      const sep = i === 0 ? '' : ' ';
      if (prev && prev.bold === b && prev.italic === it) {
        prev.text += sep + w.t;
      } else {
        runs.push({ text: sep + w.t, bold: b, italic: it });
      }
    }
    return runs;
  }

  function cellContent(words, rect) {
    if (!words.length) return { text: '', linesRuns: [], align: 'left', valign: 'center', hMed: 0, bold: false, italic: false };
    const lines = groupWordsToLines(words);
    const innerW = Math.max(1, rect.x1 - rect.x0);
    let text = '';
    const linesRuns = [];

    lines.forEach((ln, i) => {
      const t = ln.words.map(w => w.t).join(' ');
      const runs = buildRunsFromWords(ln.words);
      if (i === 0) {
        text = t;
        linesRuns.push(runs);
        return;
      }
      const prev = lines[i - 1];
      const prevR = Math.max(...prev.words.map(w => w.x1));
      if (prevR - rect.x0 < innerW * 0.62) {
        text += '\n' + t;
        linesRuns.push(runs);
      } else {
        text += ' ' + t;
        const lastLine = linesRuns[linesRuns.length - 1];
        if (runs.length) {
          runs[0].text = ' ' + runs[0].text;
          lastLine.push(...runs);
        }
      }
    });

    const minX = Math.min(...words.map(w => w.x0)), maxX = Math.max(...words.map(w => w.x1));
    const minY = Math.min(...words.map(w => w.y0)), maxY = Math.max(...words.map(w => w.y1));
    const lg = minX - rect.x0, rg = rect.x1 - maxX;
    let align = 'left';
    if ((maxX - minX) <= innerW * 0.85) {
      if (Math.abs(lg - rg) < innerW * 0.1 && lg > innerW * 0.08) align = 'center';
      else if (lg > rg * 2.2 && lg > innerW * 0.2) align = 'right';
    }
    const tg = minY - rect.y0, bg = rect.y1 - maxY, innerH = rect.y1 - rect.y0;
    let valign = 'center';
    if (innerH > (maxY - minY) * 1.8) {
      if (bg < tg * 0.4) valign = 'bottom';
      else if (Math.abs(tg - bg) > innerH * 0.2) valign = 'top';
    }

    const boldCount = words.filter(w => w.bold).length;
    const italicCount = words.filter(w => w.italic).length;
    return {
      text,
      linesRuns,
      align,
      valign,
      hMed: median(words.map(w => w.y1 - w.y0)),
      bold: boldCount > words.length * 0.5,
      italic: italicCount > words.length * 0.5
    };
  }

  function detectBorderless(segs) {
    if (!segs.length) return { tables: [], rest: [] };
    const sorted = [...segs].sort((a, b) => ((a.y0 + a.y1) - (b.y0 + b.y1)) || a.x0 - b.x0);
    const rows = [];
    for (const s of sorted) {
      const cy = (s.y0 + s.y1) / 2;
      const last = rows[rows.length - 1];
      if (last && Math.abs(cy - last.cy) <= 0.55 * Math.min(s.h, last.h)) {
        last.segs.push(s);
        last.cy = (last.cy * (last.segs.length - 1) + cy) / last.segs.length;
        last.y0 = Math.min(last.y0, s.y0); last.y1 = Math.max(last.y1, s.y1);
        last.h = Math.max(last.h, s.h);
      } else rows.push({ segs: [s], cy, y0: s.y0, y1: s.y1, h: s.h });
    }
    rows.forEach(r => { r.segs.sort((a, b) => a.x0 - b.x0); r.multi = r.segs.length >= 2; });

    const usedSeg = new Set();
    const tables = [];
    let i = 0;
    while (i < rows.length) {
      if (!rows[i].multi) { i++; continue; }
      const blk = [i];
      let j = i + 1;
      while (j < rows.length) {
        const prev = rows[blk[blk.length - 1]];
        if (rows[j].y0 - prev.y1 > 2.6 * prev.h) break;
        if (rows[j].multi) { blk.push(j); j++; continue; }
        const nx = rows[j + 1];
        if (nx && nx.multi && nx.y0 - rows[j].y1 <= 2.6 * rows[j].h) { blk.push(j); j++; continue; }
        break;
      }
      while (blk.length && !rows[blk[blk.length - 1]].multi) blk.pop();
      const next = blk[blk.length - 1] + 1;
      const t = evalBlock(blk.map(k => rows[k]));
      if (t) { tables.push(t); t.rows.forEach(r => r.segs.forEach(s => usedSeg.add(s))); }
      i = next;
    }
    return { tables: tables.map(t => t.table), rest: segs.filter(s => !usedSeg.has(s)) };
  }

  function evalBlock(rows) {
    const multi = rows.filter(r => r.multi);
    const hMed = median(rows.map(r => r.h)) || 10;
    const iv = [];
    multi.forEach(r => r.segs.forEach(s => iv.push([s.x0, s.x1])));
    iv.sort((a, b) => a[0] - b[0]);
    const cols = [];
    for (const [a, b] of iv) {
      const last = cols[cols.length - 1];
      if (last && a - last[1] < hMed * 1.0) last[1] = Math.max(last[1], b);
      else cols.push([a, b]);
    }
    if (cols.length < 2) return null;
    const colOf = s => cols.map((c, k) => (s.x0 < c[1] && s.x1 > c[0]) ? k : -1).filter(k => k >= 0);
    for (const r of multi) {
      const seen = new Set();
      for (const s of r.segs) {
        const ks = colOf(s);
        if (ks.length !== 1 || seen.has(ks[0])) return null;
        seen.add(ks[0]);
      }
    }
    if (multi.length === 1 && rows.length === 1) {
      const sg = rows[0].segs;
      let minGap = Infinity;
      for (let k = 1; k < sg.length; k++) minGap = Math.min(minGap, sg[k].x0 - sg[k - 1].x1);
      if (minGap < 3 * hMed) return null;
    }
    const colAlign = cols.map((_, k) => {
      const ss = [];
      multi.forEach(r => r.segs.forEach(sg => { if (colOf(sg)[0] === k) ss.push(sg); }));
      if (ss.length < 2) return 'left';
      const spread = a => Math.max(...a) - Math.min(...a);
      const sl = spread(ss.map(v => v.x0)), sr = spread(ss.map(v => v.x1)), sc = spread(ss.map(v => (v.x0 + v.x1) / 2));
      if (sr < sl * 0.6 && sr <= sc) return 'right';
      if (sc < sl * 0.6 && sc < sr) return 'center';
      return 'left';
    });

    const units = [];
    const xs = [cols[0][0] - 2];
    for (let k = 0; k < cols.length; k++) {
      units.push(k);
      if (k === cols.length - 1) { xs.push(cols[k][1] + 2); break; }
      const gapL = cols[k][1] + 2, gapR = cols[k + 1][0] - 2;
      if (colAlign[k] === 'left') xs.push(gapR);
      else if (colAlign[k + 1] === 'right') xs.push(gapL);
      else if (gapR - gapL > 1) { xs.push(gapL); units.push(-1); xs.push(gapR); }
      else xs.push((gapL + gapR) / 2);
    }
    const unitOf = k => units.indexOf(k);

    const ys = [rows[0].y0 - 0.2 * hMed];
    for (let k = 1; k < rows.length; k++) ys.push((rows[k - 1].y1 + rows[k].y0) / 2);
    ys.push(rows[rows.length - 1].y1 + 0.2 * hMed);

    const R = rows.length, C = units.length;
    const owner = Array.from({ length: R }, () => Array(C).fill(-1));
    const cells = [];
    rows.forEach((row, r) => {
      row.segs.forEach(sg => {
        const ks = colOf(sg);
        if (!ks.length) return;
        const c0 = unitOf(ks[0]), c1 = unitOf(ks[ks.length - 1]);
        const idx = cells.length;
        cells.push({
          r, c: c0, rs: 1, cs: c1 - c0 + 1, words: sg.words, seg: sg,
          forceAlign: ks.length === 1 ? colAlign[ks[0]] : 'left'
        });
        for (let c = c0; c <= c1; c++) owner[r][c] = idx;
      });
    });
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      if (owner[r][c] < 0) { owner[r][c] = cells.length; cells.push({ r, c, rs: 1, cs: 1, words: [] }); }
    }
    return { rows, table: { xs, ys, cells, owner, R, C, bordered: false } };
  }

  function analyzePage(inp) {
    const { cw, ch, scale: k, opts = {} } = inp;
    const pageW = cw / k, pageH = ch / k;
    const tables = inp.tables || [];
    const cellWords = tables.map(t => t.cells.map(() => []));
    const bodyLines = [];

    for (const ln of inp.lines) {
      const rest = [];
      for (const w of ln.words) {
        const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
        const ti = tables.findIndex(t =>
          cx >= t.xs[0] - 3 && cx <= t.xs[t.xs.length - 1] + 3 && cy >= t.ys[0] - 3 && cy <= t.ys[t.ys.length - 1] + 3);
        if (ti < 0) { rest.push(w); continue; }
        const t = tables[ti];
        const r = locate(t.ys, cy), c = locate(t.xs, cx);
        cellWords[ti][t.owner[r][c]].push(w);
      }
      if (rest.length) bodyLines.push(rest);
    }

    const segs = [];
    for (const ws of bodyLines) {
      const sorted = [...ws].sort((a, b) => a.x0 - b.x0);
      const hMed = median(sorted.map(w => w.y1 - w.y0)) || 10;
      let cur = [sorted[0]];
      const flush = () => {
        segs.push({
          x0: Math.min(...cur.map(w => w.x0)), x1: Math.max(...cur.map(w => w.x1)),
          y0: Math.min(...cur.map(w => w.y0)), y1: Math.max(...cur.map(w => w.y1)),
          h: median(cur.map(w => w.y1 - w.y0)) || hMed, words: cur, text: cur.map(w => w.t).join(' ')
        });
      };
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].x0 - sorted[i - 1].x1 > 2.2 * hMed) { flush(); cur = [sorted[i]]; }
        else cur.push(sorted[i]);
      }
      flush();
    }

    let flow = segs;
    let loose = [];
    if (opts.borderless !== false) {
      const bl = detectBorderless(segs);
      loose = bl.tables;
      flow = bl.rest;
    }

    const lineObjs = flow.map(s => ({
      text: s.text, x: s.x0 / cw, y: s.y0 / ch, w: (s.x1 - s.x0) / cw, h: s.h / ch, ink: null,
      words: s.words.map(w => ({
        t: w.t, x: w.x0 / cw, w: (w.x1 - w.x0) / cw, c: w.c,
        bold: !!w.bold, italic: !!w.italic, sizePt: w.sizePt || null
      }))
    }));
    const paras = root.groupLinesIntoParagraphs ? root.groupLinesIntoParagraphs(lineObjs) : [];
    const jr = root.justifyRefFrom ? root.justifyRefFrom(paras, pageW, pageH) : null;

    const allH = [];
    inp.lines.forEach(l => l.words.forEach(w => allH.push(w.y1 - w.y0)));
    const refH = median(allH) || 10;
    const baseSize = inp.font && inp.font.size ? inp.font.size : clamp(refH / k / 0.72, 6, 24);
    const sizeFor = hPx => clamp(Math.round(baseSize * (hPx / refH) * 2) / 2, 6, 48);
    const fontFam = pickSafeTurkishFont(inp.font && inp.font.family);

    const blocks = [];

    for (const p of paras) {
      const lay = root.detectParagraphLayout
        ? root.detectParagraphLayout({ w: pageW, h: pageH }, p, jr)
        : { align: 'left', indentPt: 0, pitchPt: null };
      const x0 = p.x * pageW, x1 = (p.x + p.w) * pageW;
      const y0 = p.y * pageH, lineH = p.lineH * pageH;
      const n = Math.max(1, (p.lines || []).length);

      const ptSizes = (p.words || []).map(w => w.sizePt).filter(Boolean);
      const size = ptSizes.length ? clamp(Math.round(median(ptSizes) * 2) / 2, 6, 48) : sizeFor(p.lineH * ch);
      let pitch = lay.pitchPt || lineH * 1.3;
      pitch = Math.max(pitch, size * 1.1);
      const top = Math.max(0, y0 - Math.max(0, (pitch - lineH) / 2));

      let ink = null;
      if (inp.inkAt) {
        const h = inp.inkAt(p.x * cw, p.y * ch, (p.x + p.w) * cw, (p.y + p.h) * ch);
        if (h) ink = h;
      }

      const pWords = p.words || [];
      const bold = pWords.length ? pWords.filter(w => w.bold).length > pWords.length * 0.5 : !!(inp.font && inp.font.bold);
      const italic = pWords.length ? pWords.filter(w => w.italic).length > pWords.length * 0.5 : !!(inp.font && inp.font.italic);
      const runs = (!p.text.includes('\n') && pWords.length) ? buildRunsFromWords(pWords) : null;

      blocks.push({
        type: 'para', x0, x1: lay.align === 'justify' ? x1 : x1 + 0.5 * lineH, top, bottom: top + n * pitch,
        text: p.text, runs, bold, italic, align: lay.align, firstLine: lay.indentPt, pitch, size, color: ink
      });
    }

    const toTable = (t, contentFn) => {
      const xsPt = t.xs.map(v => v / k), ysPt = t.ys.map(v => v / k);
      const outCells = [];
      const hs = [];
      t.cells.forEach((c, idx) => {
        const rect = { x0: t.xs[c.c], x1: t.xs[c.c + c.cs], y0: t.ys[c.r], y1: t.ys[c.r + c.rs] };
        const ct = contentFn(c, idx, rect);
        if (ct.hMed) hs.push(ct.hMed);
        outCells.push({
          r: c.r, c: c.c, rs: c.rs, cs: c.cs, text: ct.text, linesRuns: ct.linesRuns || [],
          bold: !!ct.bold, italic: !!ct.italic,
          align: c.forceAlign || ct.align, valign: ct.valign, fill: ct.fill || null, color: ct.color || null, hMed: ct.hMed
        });
      });
      const size = sizeFor(median(hs) || refH);
      return {
        type: 'table', bordered: t.bordered, x0: xsPt[0], x1: xsPt[xsPt.length - 1],
        top: ysPt[0], bottom: ysPt[ysPt.length - 1], cols: xsPt, rows: ysPt,
        R: t.R, C: t.C, owner: t.owner, cells: outCells, size
      };
    };

    tables.forEach((t, ti) => {
      blocks.push(toTable(t, (c, idx, rect) => {
        const ct = cellContent(cellWords[ti][idx], rect);
        let fill = null, color = null;
        if (inp.fillAt) {
          fill = inp.fillAt(rect.x0, rect.y0, rect.x1, rect.y1);
          if (fill) {
            const n = parseInt(fill.slice(1), 16);
            const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255));
            if (lum < 110) color = 'FFFFFF';
          }
        }
        return { ...ct, fill, color };
      }));
    });

    loose.forEach(t => {
      blocks.push(toTable(t, (c, idx, rect) => {
        const ct = cellContent(c.words, rect);
        return { ...ct, text: c.words.map(w => w.t).join(' '), align: 'left', valign: 'center' };
      }));
    });

    blocks.sort((a, b) => a.top - b.top || a.x0 - b.x0);
    return {
      wPt: pageW, hPt: pageH, family: fontFam,
      bold: !!(inp.font && inp.font.bold), italic: !!(inp.font && inp.font.italic),
      baseSize, blocks, mode: inp.mode || 'ocr'
    };
  }

  /* ======================================================================
     5) Word (.docx) üretimi
     ====================================================================== */
  const tw = pt => Math.round(pt * 20);

  function rPr(f) {
    const fam = esc(f.family);
    return `<w:rPr><w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:cs="${fam}" w:eastAsia="${fam}"/>` +
      (f.bold ? '<w:b/>' : '') + (f.italic ? '<w:i/>' : '') +
      (f.color ? `<w:color w:val="${f.color}"/>` : '') +
      `<w:sz w:val="${Math.round(f.size * 2)}"/><w:szCs w:val="${Math.round(f.size * 2)}"/><w:lang w:val="tr-TR"/></w:rPr>`;
  }

  function wPara(textOrRuns, o) {
    const jc = { left: 'left', center: 'center', right: 'right', justify: 'both' }[o.align || 'left'];
    let ppr = `<w:spacing w:before="${o.before | 0}" w:after="0"` +
      (o.line ? ` w:line="${o.line}" w:lineRule="${o.lineRule || 'exact'}"` : '') + '/>';
    if (o.left || o.right || o.firstLine) {
      ppr += `<w:ind w:left="${o.left | 0}" w:right="${o.right | 0}"` + (o.firstLine ? ` w:firstLine="${o.firstLine | 0}"` : '') + '/>';
    }
    ppr += `<w:jc w:val="${jc}"/>`;

    let runsXml = '';
    if (Array.isArray(textOrRuns) && textOrRuns.length) {
      runsXml = textOrRuns.map(rn => {
        if (!rn.text) return '';
        const rf = { ...o.font, bold: rn.bold ?? o.font.bold, italic: rn.italic ?? o.font.italic };
        return `<w:r>${rPr(rf)}<w:t xml:space="preserve">${esc(rn.text)}</w:t></w:r>`;
      }).join('');
    } else if (typeof textOrRuns === 'string' && textOrRuns) {
      runsXml = `<w:r>${rPr(o.font)}<w:t xml:space="preserve">${esc(textOrRuns)}</w:t></w:r>`;
    }
    return `<w:p><w:pPr>${ppr}</w:pPr>${runsXml}</w:p>`;
  }

function wTable(b, page, marginL, font) {
    const colsTw = [];
    for (let i = 0; i < b.cols.length - 1; i++) colsTw.push(Math.max(60, tw(b.cols[i + 1] - b.cols[i])));
    const total = colsTw.reduce((s, v) => s + v, 0);
    const spanW = (c, cs) => colsTw.slice(c, c + cs).reduce((s, v) => s + v, 0);
    const border = b.bordered
      ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map(n => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="444444"/>`).join('') + '</w:tblBorders>'
      : '';
    // Çizgisiz (iki sütun/hizalı) tablolarda dikey şişmeyi ve erken satır kırılmasını önlemek için marjları daralt
    const marV = b.bordered ? 20 : 0;
    const marH = b.bordered ? 60 : 12;
    let x = `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblInd w:w="${tw(b.x0 - marginL)}" w:type="dxa"/>` +
      border + `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="${marV}" w:type="dxa"/><w:left w:w="${marH}" w:type="dxa"/>` +
      `<w:bottom w:w="${marV}" w:type="dxa"/><w:right w:w="${marH}" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>` +
      colsTw.map(v => `<w:gridCol w:w="${v}"/>`).join('') + '</w:tblGrid>';

    const firstRowCells = b.cells.filter(c => c.r === 0);
    const isHeaderRow = b.bordered && b.R > 1 && firstRowCells.length > 0 &&
      firstRowCells.filter(c => c.fill || c.bold).length >= Math.ceil(firstRowCells.length * 0.5);

    const cellLineTw = b.bordered ? 240 : Math.max(160, tw(b.size * 1.12));
    const cellLineRule = b.bordered ? 'auto' : 'atLeast';

    for (let r = 0; r < b.R; r++) {
      const minRowTw = b.bordered ? 200 : 120;
      const hTw = Math.max(minRowTw, tw(b.rows[r + 1] - b.rows[r]));
      const hdrTag = (r === 0 && isHeaderRow) ? '<w:tblHeader/>' : '';
      x += `<w:tr><w:trPr><w:cantSplit/>${hdrTag}<w:trHeight w:val="${hTw}" w:hRule="atLeast"/></w:trPr>`;
      let c = 0;
      while (c < b.C) {
        const cell = b.cells[b.owner[r][c]];
        const span = `<w:gridSpan w:val="${cell.cs}"/>`;
        const wTc = `<w:tcW w:w="${spanW(cell.c, cell.cs)}" w:type="dxa"/>`;
        const vAlign = `<w:vAlign w:val="${cell.valign === 'bottom' ? 'bottom' : cell.valign === 'top' ? 'top' : 'center'}"/>`;
        const shd = cell.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${cell.fill.replace('#', '').toUpperCase()}"/>` : '';
        if (cell.r === r) {
          let tcpr = wTc + (cell.cs > 1 ? span : '') + (cell.rs > 1 ? '<w:vMerge w:val="restart"/>' : '') + shd + vAlign;
          const f = { family: font.family, size: b.size, bold: cell.bold, italic: cell.italic, color: cell.color };
          let ps = '';
          if (cell.linesRuns && cell.linesRuns.length) {
            ps = cell.linesRuns.map(runs => wPara(runs, { align: cell.align, font: f, line: cellLineTw, lineRule: cellLineRule })).join('');
          } else {
            const parts = String(cell.text || '').split('\n');
            ps = parts.map(t => wPara(t, { align: cell.align, font: f, line: cellLineTw, lineRule: cellLineRule })).join('');
          }
          x += `<w:tc><w:tcPr>${tcpr}</w:tcPr>${ps}</w:tc>`;
        } else {
          x += `<w:tc><w:tcPr>${wTc}${cell.cs > 1 ? span : ''}<w:vMerge/>${vAlign}</w:tcPr><w:p/></w:tc>`;
        }
        c += cell.cs;
      }
      x += '</w:tr>';
    }
    return x + '</w:tbl>';
  }

function pageBody(page, isLast) {
    const bl = page.blocks;
    const font = { family: page.family, bold: false, italic: false };
    const left = bl.length ? Math.max(0, Math.min(...bl.map(b => b.x0))) : 36;
    const right = bl.length ? Math.max(0, page.wPt - Math.max(...bl.map(b => b.x1)) - 4) : 36;
    const top = bl.length ? Math.max(0, bl[0].top) : 36;
    const maxBottom = bl.length ? Math.max(...bl.map(b => b.bottom)) : 100;
    // Word'de 1 sayfalık içeriğin alt boşluk yüzünden 2. sayfaya taşmasını önlemek için alt marjı esnek tut
    const rawBottom = Math.max(0, page.hPt - maxBottom - 8);
    const bottom = Math.min(rawBottom, 18);

    let out = '';
    let cursor = top;
    for (const b of bl) {
      const gap = Math.max(0, b.top - cursor);
      if (b.type === 'para') {
        const f = {
          ...font,
          size: b.size,
          bold: !!b.bold,
          italic: !!b.italic,
          color: b.color ? b.color.replace('#', '').toUpperCase() : null
        };
        const nLines = Math.max(1, Math.round((b.bottom - b.top) / b.pitch));
        if (b.runs && b.runs.length) {
          out += wPara(b.runs, {
            align: b.align, font: f, before: tw(gap), line: tw(b.pitch), lineRule: 'exact',
            left: tw(b.x0 - left), right: tw(Math.max(0, page.wPt - right - b.x1)),
            firstLine: tw(b.firstLine || 0)
          });
        } else {
          const parts = String(b.text).split('\n');
          parts.forEach((t, i) => {
            out += wPara(t, {
              align: b.align, font: f, before: i === 0 ? tw(gap) : 0, line: tw(b.pitch), lineRule: 'exact',
              left: tw(b.x0 - left), right: tw(Math.max(0, page.wPt - right - b.x1)),
              firstLine: i === 0 ? tw(b.firstLine || 0) : 0
            });
          });
        }
        cursor = b.top + nLines * b.pitch;
      } else {
        if (gap >= 1) out += wPara('', { font: { ...font, size: 1 }, line: Math.max(20, tw(gap)), lineRule: 'exact' });
        out += wTable(b, page, left, font);
        cursor = b.bottom;
      }
    }
    const sect = `<w:sectPr><w:pgSz w:w="${tw(page.wPt)}" w:h="${tw(page.hPt)}"/>` +
      `<w:pgMar w:top="${tw(top)}" w:right="${tw(right)}" w:bottom="${tw(bottom)}" w:left="${tw(left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    const closer = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${isLast ? '' : sect}<w:rPr><w:sz w:val="2"/></w:rPr></w:pPr></w:p>`;
    return { xml: out + closer, sect };
  }

  async function buildDocx(pages) {
    let body = '';
    let lastSect = '';
    pages.forEach((pg, i) => {
      const r = pageBody(pg, i === pages.length - 1);
      body += r.xml; lastSect = r.sect;
    });
    const fam = esc(pages[0] ? pages[0].family : 'Arial');
    const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${fam}" w:hAnsi="${fam}" w:cs="${fam}" w:eastAsia="${fam}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="tr-TR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>` },
      { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${lastSect}</w:body></w:document>` }
    ];
    return makeZip(files);
  }

  /* ======================================================================
     6) Excel (.xlsx) üretimi (Para Birimi, Yüzde, Tarih ve Stil Destekli)
     ====================================================================== */
  const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

  function createStyles() {
    const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
    const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const maps = { font: new Map(), fill: new Map(), border: new Map(), xf: new Map() };
    const pick = (map, arr, key, xml) => { if (!map.has(key)) { map.set(key, arr.length); arr.push(xml); } return map.get(key); };
    const fontXml = f => `<font>${f.bold ? '<b/>' : ''}${f.italic ? '<i/>' : ''}<sz val="${f.size}"/><color rgb="FF${f.color || '000000'}"/><name val="${esc(f.name)}"/></font>`;
    fonts.push(fontXml({ name: 'Calibri', size: 11 }));
    maps.font.set('Calibri|11||||', 0);

    const customNumFmts =
      '<numFmts count="4">' +
      '<numFmt numFmtId="164" formatCode="#,##0.00 &quot;₺&quot;"/>' +
      '<numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/>' +
      '<numFmt numFmtId="166" formatCode="#,##0.00 &quot;€&quot;"/>' +
      '<numFmt numFmtId="168" formatCode="dd.mm.yyyy"/>' +
      '</numFmts>';

    function xf(s) {
      const fk = `${s.font.name}|${s.font.size}|${s.font.bold ? 1 : 0}|${s.font.italic ? 1 : 0}|${s.font.color || ''}|`;
      const fontId = pick(maps.font, fonts, fk, fontXml(s.font));
      const fillId = s.fill ? pick(maps.fill, fills, s.fill, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const borderId = s.border ? pick(maps.border, borders, 'thin', '<border><left style="thin"><color rgb="FF888888"/></left><right style="thin"><color rgb="FF888888"/></right><top style="thin"><color rgb="FF888888"/></top><bottom style="thin"><color rgb="FF888888"/></bottom><diagonal/></border>') : 0;
      const key = [fontId, fillId, borderId, s.h || '', s.v || '', s.wrap ? 1 : 0, s.numFmt || 0].join('|');
      return pick(maps.xf, xfs, key,
        `<xf numFmtId="${s.numFmt || 0}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"${s.numFmt ? ' applyNumberFormat="1"' : ''}>` +
        `<alignment${s.h ? ` horizontal="${s.h}"` : ''} vertical="${s.v || 'top'}"${s.wrap ? ' wrapText="1"' : ''}/></xf>`);
    }
    const xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      customNumFmts +
      `<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills>` +
      `<borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    return { xf, xml };
  }

  function buildSheet(page, st, opts) {
    const blocks = page.blocks.filter(b => b.type === 'table' || opts.includeText !== false);
    if (!blocks.length) return null;
    const left = Math.min(...blocks.map(b => b.x0)), right = Math.max(...blocks.map(b => b.x1));
    let tol = Math.max(4, page.wPt * 0.008);
    let bounds;
    for (let it = 0; it < 8; it++) {
      const xs = [left, right];
      blocks.forEach(b => { if (b.type === 'table') xs.push(...b.cols); });
      bounds = clusterPos(xs, tol);
      if (bounds.length <= 70) break;
      tol *= 1.6;
    }
    const idxOf = x => { let bi = 0, bd = Infinity; bounds.forEach((v, i) => { const d = Math.abs(v - x); if (d < bd) { bd = d; bi = i; } }); return bi; };
    const G = bounds.length - 1;
    if (G < 1) return null;

    const rows = [];
    const merges = [];
    const newRow = ht => { const r = { ht: clamp(ht, 6, 409), cells: new Map() }; rows.push(r); return rows.length; };
    const font = (size, extra = {}) => ({ name: page.family, size: clamp(Math.round(size * 2) / 2, 6, 36), bold: false, italic: false, ...extra });
    const cellXml = (rIdx, c, style, val) => {
      const ref = colName(c) + rIdx;
      if (val == null || val === '') return `<c r="${ref}" s="${style}"/>`;
      if (typeof val === 'number') return `<c r="${ref}" s="${style}"><v>${val}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
    };

    let cursor = blocks[0].top;
    for (const b of blocks) {
      const gap = b.top - cursor;
      if (gap >= 8) newRow(Math.min(gap, 60));
      if (b.type === 'para') {
        const lines = Math.max(1, String(b.text).split('\n').length, Math.round((b.bottom - b.top) / b.pitch));
        const rIdx = newRow(lines * b.pitch + 3);
        const s = st.xf({
          font: font(b.size, { bold: !!b.bold, italic: !!b.italic, color: b.color ? b.color.replace('#', '').toUpperCase() : null }),
          h: b.align === 'justify' ? 'left' : b.align, v: 'top', wrap: true
        });
        for (let c = 0; c < G; c++) rows[rIdx - 1].cells.set(c, cellXml(rIdx, c, s, c === 0 ? b.text : null));
        if (G > 1) merges.push(`A${rIdx}:${colName(G - 1)}${rIdx}`);
        cursor = b.bottom;
      } else {
        const start = rows.length + 1;
        const colIdx = b.cols.map(idxOf);
        for (let r = 0; r < b.R; r++) newRow(b.rows[r + 1] - b.rows[r] + 2);
        b.cells.forEach(cell => {
          const c0 = colIdx[cell.c];
          let c1 = colIdx[cell.c + cell.cs] - 1;
          if (c1 < c0) c1 = c0;
          const r0 = start + cell.r, r1 = start + cell.r + cell.rs - 1;

          let val = cell.text, numFmt = 0;
          if (opts.numbers !== false) {
            const parsed = parseExcelValue(val);
            val = parsed.val;
            numFmt = parsed.numFmt;
          }

          const s = st.xf({
            font: font(b.size, { bold: !!cell.bold, italic: !!cell.italic, color: cell.color }),
            fill: cell.fill ? cell.fill.replace('#', '').toUpperCase() : null,
            border: b.bordered,
            h: typeof val === 'number' && cell.align === 'left' ? 'right' : cell.align,
            v: cell.valign === 'bottom' ? 'bottom' : cell.valign === 'top' ? 'top' : 'center',
            wrap: true,
            numFmt
          });
          for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
            rows[rr - 1].cells.set(cc, cellXml(rr, cc, s, rr === r0 && cc === c0 ? val : null));
          }
          if (r1 > r0 || c1 > c0) merges.push(`${colName(c0)}${r0}:${colName(c1)}${r1}`);
        });
        cursor = b.bottom;
      }
    }

    const colW = bounds.slice(1).map((v, i) => {
      const px = (v - bounds[i]) * 96 / 72;
      return Math.max(2, +(((px + 6) / 7)).toFixed(2));
    });
    const gridFlag = opts.gridLines ? '1' : '0';
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetViews><sheetView workbookViewId="0" showGridLines="${gridFlag}"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>` +
      colW.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols><sheetData>';
    rows.forEach((r, i) => {
      const cs = [...r.cells.keys()].sort((a, b) => a - b).map(k => r.cells.get(k)).join('');
      xml += `<row r="${i + 1}" ht="${r.ht.toFixed(1)}" customHeight="1">${cs}</row>`;
    });
    xml += '</sheetData>';
    if (merges.length) xml += `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`;
    xml += '<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/></worksheet>';
    return xml;
  }

  async function buildXlsx(pages, opts = {}) {
    const st = createStyles();
    const sheets = [];
    pages.forEach((pg, i) => {
      const xml = buildSheet(pg, st, opts);
      if (xml) sheets.push({ name: `Sayfa ${pg.n || i + 1}`, xml });
    });
    if (!sheets.length) return null;
    const files = [
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: st.xml() },
      ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml }))
    ];
    return makeZip(files);
  }

  /* ======================================================================
     7) Tarayıcı tarafı: Hibrit okuma (Dijital PDF Metni + Çizgiler + OCR)
     ====================================================================== */
  async function extractDigitalLines(page, vp, sc) {
    const tc = await page.getTextContent();
    const items = (tc.items || []).filter(it => it.str && it.str.trim());
    if (items.length < 3) return null;

    const totalChars = items.reduce((s, it) => s + it.str.trim().length, 0);
    if (totalChars < 12) return null;

    // Bozuk font haritası (tofu / PUA karakteri) varsa dijital metni pas geçip OCR'a düş
    const joinedSample = items.map(it => normTr(it.str)).join('');
    const brokenCount = (joinedSample.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
    if (brokenCount > Math.max(2, totalChars * 0.02)) return null;

    const styles = tc.styles || {};
    const fobj = id => {
      try { return page.commonObjs.has(id) ? page.commonObjs.get(id) : null; } catch (_) { return null; }
    };

    const frags = [];
    const famVotes = new Map();

    for (const it of items) {
      if (!it.transform) continue;
      const angle = Math.abs(Math.atan2(it.transform[1], it.transform[0]) * 180 / Math.PI);
      if (angle > 5 && angle < 355) continue;

      const ptSize = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      if (ptSize < 4) continue;

      const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      const hPx = ptSize * sc;
      const raw = normTr(it.str);
      const wPx = (it.width || (raw.length * ptSize * 0.5)) * sc;
      const y1 = vy;
      const y0 = vy - hPx;

      const fo = fobj(it.fontName);
      const rawName = (fo && fo.name) ? String(fo.name) : '';
      const st = styles[it.fontName] || {};
      const info = `${rawName} ${it.fontName || ''} ${st.fontFamily || ''}`.toLowerCase();
      const bold = !!(fo && fo.bold) || /bold|black|heavy|semibold|demi|\bbd\b/.test(info);
      const italic = !!(fo && fo.italic) || /italic|oblique|\bit\b/.test(info);

      const matchedFam = (typeof matchInstalledFamily === 'function') ? matchInstalledFamily(rawName) : null;
      const fam = pickSafeTurkishFont(matchedFam, info);
      famVotes.set(fam, (famVotes.get(fam) || 0) + raw.trim().length);

      const parts = raw.split(/(\s+)/);
      const totalLen = Math.max(1, raw.length);
      let charPos = 0;
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        const len = part.length;
        if (part.trim()) {
          const wx0 = vx + (charPos / totalLen) * wPx;
          const wx1 = vx + ((charPos + len) / totalLen) * wPx;
          frags.push({
            t: part.trim(),
            x0: wx0, y0, x1: Math.max(wx0 + 1, wx1), y1,
            c: 100, bold, italic, sizePt: ptSize,
            leadSp: pi > 0 && /^\s+$/.test(parts[pi - 1]),
            trailSp: pi < parts.length - 1 && /^\s+$/.test(parts[pi + 1])
          });
        }
        charPos += len;
      }
    }

    if (frags.length < 3) return null;

    let bestFam = 'Arial', bestCnt = -1;
    for (const [k, v] of famVotes) if (v > bestCnt) { bestCnt = v; bestFam = k; }
    bestFam = pickSafeTurkishFont(bestFam);

    // Satırlara ayır ve bitişik parçaları (ör. ayrı çizilen Türkçe harfleri) aynı kelimede birleştir
    const rawLines = groupWordsToLines(frags);
    const lines = rawLines.map(ln => {
      const merged = [];
      for (const f of ln.words) {
        const prev = merged[merged.length - 1];
        const hRef = prev ? Math.min(prev.y1 - prev.y0, f.y1 - f.y0) : (f.y1 - f.y0);
        const gap = prev ? (f.x0 - prev.x1) : Infinity;
        if (prev && !prev.trailSp && !f.leadSp && gap < Math.max(1.5, hRef * 0.16)) {
          prev.t += f.t;
          prev.x1 = Math.max(prev.x1, f.x1);
          prev.y0 = Math.min(prev.y0, f.y0);
          prev.y1 = Math.max(prev.y1, f.y1);
          prev.bold = prev.bold || f.bold;
          prev.italic = prev.italic || f.italic;
          prev.trailSp = f.trailSp;
        } else {
          merged.push({ ...f });
        }
      }
      return { words: merged };
    });

    const medSize = median(frags.map(w => w.sizePt)) || 11;
    return { lines, font: { family: bestFam, size: medSize, bold: false, italic: false } };
  }

  function wordsFromTesseract(data, ch) {
    const lines = [];
    for (const ln of (data.lines || [])) {
      const ws = [];
      for (const wd of (ln.words || [])) {
        const t = normTr(wd.text || '').trim();
        if (!t) continue;
        if (typeof wd.confidence === 'number' && wd.confidence < 30) continue;
        if ((wd.bbox.y1 - wd.bbox.y0) / ch > 0.09) continue;
        ws.push({ t, x0: wd.bbox.x0, y0: wd.bbox.y0, x1: wd.bbox.x1, y1: wd.bbox.y1, c: wd.confidence });
      }
      if (ws.length) lines.push({ words: ws });
    }
    return lines;
  }

async function scanPage(pg, opts, onStep) {
    // Dosya PDF değil de görsel (PNG/JPG/ekran görüntüsü) ise ayrı görsel motoruna yönlendir
    if (S.isImageDoc && root.ImageExport && typeof root.ImageExport.scanImagePage === 'function') {
      return await root.ImageExport.scanImagePage(pg, opts, onStep);
    }

    if (typeof initSystemFonts === 'function') {
      try { await initSystemFonts(); } catch (_) {}
    }

    const page = await S.doc.getPage(pg.n);
    const rot = typeof rotOf === 'function' ? rotOf(pg) : 0;
    const sc = ocrScale(pg, false);
    const vp = page.getViewport({ scale: sc, rotation: rot });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const cw = c.width, ch = c.height;
    const baseW = (rot % 180) ? pg.h : pg.w;
    const k = cw / baseW;

    onStep('Tablo çizgileri aranıyor');
    const img = ctx.getImageData(0, 0, cw, ch);
    const dark = buildDark(img.data, cw, ch);
    const ruling = detectRuling(dark, cw, ch);
    const tol = Math.max(4, Math.round(cw * 0.004));
    const tables = findGridTables(ruling, { tol, minGapX: Math.max(10, cw * 0.008), minGapY: Math.max(8, ch * 0.004) });

    let lines = null;
    let font = null;
    let mode = 'ocr';

    if (!opts.forceOcr) {
      onStep('Dijital metin katmanı okunuyor');
      try {
        const dig = await extractDigitalLines(page, vp, sc);
        if (dig) {
          lines = dig.lines;
          font = dig.font;
          mode = 'digital';
        }
      } catch (_) {}
    }

    if (!lines) {
      const clean = document.createElement('canvas');
      clean.width = cw; clean.height = ch;
      const cctx = clean.getContext('2d');
      cctx.drawImage(c, 0, 0);
      cctx.fillStyle = '#fff';
      const pad = 2;
      for (const t of tables) {
        for (const h of ruling.h) {
          if (h.x1 >= t.xs[0] - tol && h.x0 <= t.xs[t.xs.length - 1] + tol && h.y >= t.ys[0] - tol && h.y <= t.ys[t.ys.length - 1] + tol) {
            cctx.fillRect(h.x0 - 1, h.y - h.th / 2 - pad, h.x1 - h.x0 + 2, h.th + pad * 2);
          }
        }
        for (const v of ruling.v) {
          if (v.y1 >= t.ys[0] - tol && v.y0 <= t.ys[t.ys.length - 1] + tol && v.x >= t.xs[0] - tol && v.x <= t.xs[t.xs.length - 1] + tol) {
            cctx.fillRect(v.x - v.th / 2 - pad, v.y0 - 1, v.th + pad * 2, v.y1 - v.y0 + 2);
          }
        }
      }

      onStep('Metin okunuyor (OCR)');
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(clean);
      lines = wordsFromTesseract(data, ch);
      clean.width = clean.height = 0;

      onStep('Yazı tipi çözümleniyor');
      try {
        const sample = [];
        lines.forEach(l => l.words.forEach(w => sample.push({ t: w.t, w: (w.x1 - w.x0) / cw, c: w.c })));
        const m = await matchFontByWidths(sample, baseW);
        if (m) font = { family: pickSafeTurkishFont(m.family), size: m.size, bold: m.bold, italic: m.italic };
      } catch (_) {}
    }

    onStep('Yerleşim ve renkler çözümleniyor');
    const inkAt = (x0, y0, x1, y1) => {
      try {
        const [r, g, b] = sampleInkRgbFromCtx(ctx, cw, ch, x0, y0, x1, y1);
        return (0.299 * r + 0.587 * g + 0.114 * b) < 80 ? null : rgbToHex([r, g, b]);
      } catch (_) { return null; }
    };
    const fillAt = (x0, y0, x1, y1) => {
      try {
        const ins = 4;
        if (x1 - x0 < ins * 3 || y1 - y0 < ins * 3) return null;
        const pts = [[x0 + ins, y0 + ins], [x1 - ins, y0 + ins], [x0 + ins, y1 - ins], [x1 - ins, y1 - ins]];
        const rs = [], gs = [], bs = [];
        for (const [x, y] of pts) { const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data; rs.push(d[0]); gs.push(d[1]); bs.push(d[2]); }
        const r = median(rs), g = median(gs), b = median(bs);
        if (r > 238 && g > 238 && b > 238) return null;
        return rgbToHex([r, g, b]);
      } catch (_) { return null; }
    };

    const model = analyzePage({ cw, ch, scale: k, lines, tables, opts, font, inkAt, fillAt, mode });
    model.n = pg.n;
    c.width = c.height = 0;
    return model;
  }

  function parsePageRange(txt, total) {
    const s = String(txt || '').trim();
    if (!s) return Array.from({ length: total }, (_, i) => i + 1);
    const set = new Set();
    for (const part of s.split(/[,;\s]+/)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
  }

  function saveBlob(bytes, name, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  function initUI() {
    const btn = document.getElementById('btnConvert');
    const edit = document.getElementById('btnEdit');
    if (!btn || !edit) return;
    const sync = () => { btn.disabled = edit.disabled; };
    new MutationObserver(sync).observe(edit, { attributes: true, attributeFilter: ['disabled'] });
    sync();

    let running = false, cancel = false;

    btn.onclick = () => {
      if (!S.doc || running) return;
      if (typeof initSystemFonts === 'function') initSystemFonts();

      const back = document.createElement('div');
      back.className = 'modal-back';
      back.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-label="Word / Excel'e çevir">
          <h2>PDF'i Word / Excel'e çevir</h2>
          <p class="mute">Dijital PDF'ler doğrudan vektörel metinle, taranmış sayfalar otomatik OCR ile çevrilir. Dosya tarayıcıdan çıkmaz.</p>
          <div class="row"><label><input type="checkbox" id="cvWord" checked> Word (.docx)</label>
            <label><input type="checkbox" id="cvExcel" checked> Excel (.xlsx)</label></div>
          <label class="field">Sayfalar <input type="text" id="cvPages" placeholder="Tümü  (örn. 1-3, 5)" inputmode="numeric"></label>
          <label><input type="checkbox" id="cvLoose" checked> Çizgisiz (hizalı) tabloları da algıla</label>
          <label><input type="checkbox" id="cvText" checked> Excel'e tablo dışı metni de ekle</label>
          <label><input type="checkbox" id="cvNum" checked> Excel'de sayı, para birimi, yüzde ve tarihleri biçimlendir</label>
          <label><input type="checkbox" id="cvGrid" checked> Excel'de kılavuz çizgilerini göster</label>
          <label><input type="checkbox" id="cvForceOcr"> Tüm sayfalarda zorla OCR kullan (bozuk fontlu PDF'ler için)</label>
          <div class="prog" hidden><div class="bar-in"></div></div>
          <div class="stat" aria-live="polite"></div>
          <div class="acts">
            <button type="button" class="sec" id="cvClose">Kapat</button>
            <button type="button" class="pri" id="cvGo">Dönüştür</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const q = s => back.querySelector(s);
      const stat = q('.stat'), prog = q('.prog'), pbar = q('.bar-in');
      const closeModal = () => { if (running) { cancel = true; } back.remove(); };
      q('#cvClose').onclick = closeModal;
      back.addEventListener('pointerdown', e => { if (e.target === back && !running) closeModal(); });

      q('#cvGo').onclick = async () => {
        const wantWord = q('#cvWord').checked, wantExcel = q('#cvExcel').checked;
        if (!wantWord && !wantExcel) { stat.textContent = 'En az bir çıktı türü seçin.'; return; }
        const nums = parsePageRange(q('#cvPages').value, S.pgs.length);
        if (!nums.length) { stat.textContent = 'Geçerli bir sayfa aralığı girin.'; return; }
        const opts = {
          borderless: q('#cvLoose').checked,
          includeText: q('#cvText').checked,
          numbers: q('#cvNum').checked,
          gridLines: q('#cvGrid').checked,
          forceOcr: q('#cvForceOcr').checked
        };

        running = true; cancel = false;
        q('#cvGo').disabled = true; prog.hidden = false;
        if (S.closeEditor) S.closeEditor(false);
        const models = [];
        try {
          for (let i = 0; i < nums.length; i++) {
            if (cancel) throw new Error('İptal edildi');
            const pg = S.pgs.find(p => p.n === nums[i]);
            const label = `Sayfa ${pg.n} (${i + 1}/${nums.length})`;
            pbar.style.width = (i / nums.length * 100) + '%';
            models.push(await scanPage(pg, opts, m => { stat.textContent = `${label}: ${m}…`; }));
          }
          pbar.style.width = '100%';
          stat.textContent = 'Dosyalar hazırlanıyor…';
          const base = (S.name || 'belge').replace(/\.pdf$/i, '');
          const nTables = models.reduce((s, m) => s + m.blocks.filter(b => b.type === 'table').length, 0);
          const nDig = models.filter(m => m.mode === 'digital').length;
          const nOcr = models.length - nDig;
          let msg = [];
          if (wantWord) {
            saveBlob(await buildDocx(models), base + '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            msg.push('Word');
          }
          if (wantExcel) {
            let xo = opts;
            if (!nTables && !opts.includeText) xo = { ...opts, includeText: true };
            const x = await buildXlsx(models, xo);
            if (x) {
              if (wantWord) await new Promise(r => setTimeout(r, 400));
              saveBlob(x, base + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
              msg.push('Excel');
            } else stat.textContent = 'Excel için içerik bulunamadı.';
          }
          const modeInfo = [nDig ? `${nDig} dijital` : '', nOcr ? `${nOcr} OCR` : ''].filter(Boolean).join(', ');
          stat.textContent = `Tamam: ${msg.join(' + ')} indirildi. ${nTables} tablo (${modeInfo}).`;
          toast(`Dönüştürme tamamlandı (${nTables} tablo, ${modeInfo}).`);
        } catch (e) {
          console.error(e);
          stat.textContent = 'Hata: ' + (e && e.message ? e.message : e);
        } finally {
          running = false;
          q('#cvGo').disabled = false;
        }
      };
    };
  }

  const api = {
    makeZip, buildDark, detectRuling, findGridTables, analyzePage, buildDocx, buildXlsx,
    parseTrNumber, parseExcelValue, parsePageRange, detectBorderless,
    supportsTurkishFont, pickSafeTurkishFont
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PdfExport = api;
  if (typeof document !== 'undefined' && document.getElementById) initUI();
})(typeof globalThis !== 'undefined' ? globalThis : this);