/* ---------- Genel Durum ve Yardımcılar ---------- */
const $ = s => document.querySelector(s);
const isMobile = () => window.innerWidth <= 768;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const S = {
  bytes: null,
  doc: null,
  name: 'belge.pdf',
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

  // Önceki sayfada açık düzenleme varsa kaydedip normal görünüme döndür
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
async function load(bytes, name) {
  try {
    if (S.closeEditor) S.closeEditor(true);
    if (S.doc) { try { await S.doc.destroy(); } catch (_) {} }

    const doc = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    S.bytes = bytes;
    S.doc = doc;
    S.name = name || 'belge.pdf';
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

/* ---------- Çizim ve Katman Yönetimi ---------- */
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
      const family = s.font || '"IBM Plex Sans", Arial, sans-serif';
      ctx.font = `${style}${px}px ${family}`;
      const lh = px * (s.lh || 1.25);
      s.s.split('\n').forEach((l, i) => ctx.fillText(l, s.x * W, s.y * H + i * lh));
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

  // Yalnızca aktif olan sayfada OCR metin kutularını göster
  if (S.tool === 'ocr' && S.activeOcrPg === pg && pg.ocrCache) {
    ctx.save();
    const pxLine = Math.max(1, W / 900);
    for (const seg of pg.ocrCache) {
      const isHover = pg.hoverBox === seg;
      const x = seg.x * W, y = seg.y * H, w = seg.w * W, h = seg.h * H;
      if (isHover) {
        ctx.fillStyle = 'rgba(42,91,215,0.08)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#2a5bd7';
        ctx.lineWidth = pxLine * 1.6;
      } else {
        ctx.strokeStyle = 'rgba(115,128,148,0.55)';
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
      // Başka bir sayfaya tıklanırsa aktif sayfayı oraya geçir
      if (S.activeOcrPg !== pg) {
        if (S.closeEditor) S.closeEditor(false);
        const prev = S.activeOcrPg;
        S.activeOcrPg = pg;
        if (prev) { prev.hoverBox = null; paint(prev); }
      } else if (S.closeEditor) {
        S.closeEditor(true);
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
            else toast('Burada metin kutusu yok. Parmağınızla/fareyle kutu çizin.');
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

/* ---------- Kaydet (Vektör Kapama + Yerel Tarayıcı İndirmesi) ---------- */
async function save(asNew) {
  if (S.closeEditor) S.closeEditor(false);
  const { PDFDocument, degrees, rgb } = PDFLib;
  const btn = $(asNew ? '#saveAs' : '#save');
  btn.disabled = true;

  const hexToRgb = h => {
    const n = parseInt((h || '#ffffff').slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  try {
    const src = await PDFDocument.load(S.bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const cps = await out.copyPages(src, S.pgs.map(p => p.n - 1));

    for (let i = 0; i < S.pgs.length; i++) {
      const pg = S.pgs[i], p = cps[i];
      out.addPage(p);
      p.setRotation(degrees(rotOf(pg)));

      if (pg.shapes.length) {
        const mb = p.getMediaBox();

        // 1) Kapama kutularını kenar izi olmadan doğrudan vektör çiz
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
          }
        }

        // 2) Metin ve diğer çizimleri şeffaf katman olarak ekle
        const rest = pg.shapes.filter(s => s.t !== 'white');
        if (rest.length) {
          const k = 2, c = document.createElement('canvas');
          c.width = pg.w * k; c.height = pg.h * k;
          shapes(c.getContext('2d'), rest, c.width, c.height);
          const blob = await new Promise(r => c.toBlob(r, 'image/png'));
          c.width = 0; c.height = 0;
          const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
          p.drawImage(img, { x: mb.x, y: mb.y, width: mb.width, height: mb.height });
        }
      }
    }

    const data = await out.save();
    const fname = S.name.replace(/\.pdf$/i, '') + (asNew ? '-kopya' : '-duzenlendi') + '.pdf';

    const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(asNew ? 'Yeni dosya kaydedildi.' : 'Kaydedildi.');
  } catch (e) {
    toast('Kaydedilemedi: ' + (e && e.message || 'bilinmeyen hata'), true);
  }
  btn.disabled = false;
}

$('#save').onclick = () => save(false);
$('#saveAs').onclick = () => save(true);

/* ---------- Dosya Açma, Sürükle-Bırak ve Örnek PDF ---------- */
async function openFile(f) {
  if (!f) return;
  if (f.type && f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) {
    return toast('Lütfen geçerli bir PDF dosyası seçin.', true);
  }
  load(new Uint8Array(await f.arrayBuffer()), f.name);
}

$('#file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };
addEventListener('dragover', e => { e.preventDefault(); $('#empty').classList.add('drag'); });
addEventListener('dragleave', e => { if (!e.relatedTarget) $('#empty').classList.remove('drag'); });
addEventListener('drop', e => { e.preventDefault(); $('#empty').classList.remove('drag'); openFile(e.dataTransfer.files[0]); });

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
  load(await d.save(), 'ornek.pdf');
};