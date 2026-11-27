/* ---------- PDF -> Word Dönüştürücü (Akıllı Kenar Boşlukları ve Satır Aralığı) ---------- */

function pdfColorToHex(colorArr) {
  if (!colorArr || !colorArr.length) return '#000000';
  let r, g, b;
  if (colorArr.length === 1) { r = g = b = colorArr[0]; } 
  else if (colorArr.length === 3) { [r, g, b] = colorArr; } 
  else { [r, g, b] = colorArr; }
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('');
}

async function analyzePage(pg) {
  const page = await S.doc.getPage(pg.n);
  const vp = page.getViewport({ scale: 1, rotation: 0 });
  const textContent = await page.getTextContent();
  
  const items = (textContent.items || []).filter(i => i.str && i.str.trim());
  const styles = textContent.styles || {};
  let blocks = [];
  
  if (items.length > 10) {
    for (const it of items) {
      const angle = Math.atan2(it.transform[1], it.transform[0]) * (180 / Math.PI);
      if (Math.abs(angle) > 2 && Math.abs(angle) < 358) continue;

      const [vx, vy] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
      
      const fontStyle = styles[it.fontName] || {};
      let fontFamily = fontStyle.fontFamily || 'Arial';
      let bold = /bold|black|heavy/i.test(it.fontName || fontStyle.fontFamily || '');
      let italic = /italic|oblique/i.test(it.fontName || fontStyle.fontFamily || '');
      if (fontStyle.fontFamily) fontFamily = fontStyle.fontFamily;
      
      const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
      if (size < 5) continue;

      const color = pdfColorToHex(it.color);
      
      blocks.push({
        text: it.str,
        x: vx,
        y: vy,
        w: it.width || 0,
        h: size,
        size: size,
        color: color,
        bold: bold,
        italic: italic,
        font: fontFamily
      });
    }
  } else {
    if (!pg.ocrCache) { try { await ensureOcrCache(pg); } catch(e) {} }
    blocks = (pg.ocrCache || []).map(b => {
      const estSize = Math.max(8, Math.min(24, Math.round(b.lineH * pg.h * 0.78)));
      return {
        text: b.text,
        x: b.x * pg.w,
        y: b.y * pg.h,
        w: b.w * pg.w,
        h: b.h * pg.h,
        size: estSize,
        color: b.inkHex || '#000000',
        bold: false,
        italic: false,
        font: 'Arial'
      };
    });
  }

  return { blocks, w: vp.width, h: vp.height };
}

// Satırları oluştur ve Y farklarını (line spacing) hesapla
function groupBlocksIntoStrictLines(blocks) {
  if (!blocks.length) return [];
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];

  for (const b of sorted) {
    let line = lines.find(l => Math.abs(l.y - b.y) < b.size * 0.4);
    if (!line) {
      line = { y: b.y, x: b.x, size: b.size, color: b.color, bold: b.bold, italic: b.italic, font: b.font, blocks: [] };
      lines.push(line);
    }
    line.blocks.push(b);
    if (b.x < line.x) line.x = b.x;
    if (b.size > line.size) line.size = b.size;
  }

  for (const line of lines) {
    line.blocks.sort((a, b) => a.x - b.x);
  }
  
  lines.sort((a, b) => a.y - b.y);

  // Her satır için bir sonraki satıra olan mesafeyi (line spacing) hesapla
  for (let i = 0; i < lines.length; i++) {
    if (i < lines.length - 1) {
      lines[i].spacingToNext = lines[i + 1].y - lines[i].y;
    } else {
      lines[i].spacingToNext = lines[i].size * 1.2;
    }
  }

  return lines;
}

function mergeLineText(lineBlocks) {
  let text = '';
  for (let i = 0; i < lineBlocks.length; i++) {
    const b = lineBlocks[i];
    if (i > 0) {
      const prev = lineBlocks[i - 1];
      const gap = b.x - (prev.x + prev.w);
      // Boşluk eşiğini artırdık, kelimelerin birleşmesini engelle
      if (gap > b.size * 0.1) {
        text += gap > b.size * 2.5 ? '    ' : ' '; 
      }
    }
    text += b.text;
  }
  return text;
}

async function exportToWord() {
  if (!S.doc) return;
  if (!window.docx) return toast('Word kütüphanesi yüklenemedi.', true);

  const btn = $('#toWord');
  btn.disabled = true;
  try {
    const { Document, Packer, Paragraph, TextRun, Header, Footer } = window.docx;
    
    const pagesData = [];
    for (let i = 0; i < S.pgs.length; i++) {
      toast(`Sayfa ${i+1} analiz ediliyor...`);
      const { blocks, w, h } = await analyzePage(S.pgs[i]);
      const lines = groupBlocksIntoStrictLines(blocks);
      
      // SAYFA KENAR BOŞLUKLARINI (MARGINS) HESAPLA
      // Sayfadaki en soldaki ve en sağdaki yazıların X koordinatlarını bul
      let minX = w, maxX = 0, minY = h, maxY = 0;
      for (const b of blocks) {
        if (b.x < minX) minX = b.x;
        if (b.x + b.w > maxX) maxX = b.x + b.w;
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
      }
      
      // Kenar boşluklarını Word için twip'e çevir (1 pt = 20 twip)
      // Minimum 2 cm (1134 twip) boşluk bırak
      const marginLeft = Math.max(1134, Math.round(minX * 20));
      const marginRight = Math.max(1134, Math.round((w - maxX) * 20));
      const marginTop = Math.max(1134, Math.round(minY * 20));
      const marginBottom = Math.max(1134, Math.round((h - maxY) * 20));

      pagesData.push({ lines, w, h, marginLeft, marginRight, marginTop, marginBottom });
    }

    const { headers, footers } = detectHeadersFooters(pagesData);
    const sections = [];

    for (let i = 0; i < pagesData.length; i++) {
      const { lines, w, h, marginLeft, marginRight, marginTop, marginBottom } = pagesData[i];
      
      const children = [];
      const headerChildren = [];
      const footerChildren = [];

      let currentParaText = '';
      let currentParaStyle = null;
      let currentParaIndent = 0;
      let currentParaSpacing = 0;

      const isSentenceEnd = (txt) => /[.!?:;]$/.test(txt.trim());

      const pushParagraph = () => {
        if (currentParaText.trim()) {
          children.push(new Paragraph({
            children: [
              new TextRun({
                text: currentParaText.trim(),
                font: currentParaStyle.font,
                size: Math.round(currentParaStyle.size * 2),
                color: currentParaStyle.color.replace('#', ''),
                bold: currentParaStyle.bold,
                italics: currentParaStyle.italic
              })
            ],
            // X koordinatından marginLeft'i çıkararak gerçek girintiyi bul
            // Word'deki sol boşluk (margin) zaten hesaplandığı için, indent sadece farkı belirtir.
            indent: { left: currentParaIndent > 0 ? Math.round(currentParaIndent * 20) : undefined },
            spacing: { 
              after: 80, 
              line: Math.round(currentParaSpacing * 20), // PDF'teki gerçek satır aralığı
              lineRule: "exact" // Tam olarak PDF'teki pikselleri kullan
            }
          }));
        }
        currentParaText = '';
      };

      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        const text = mergeLineText(line.blocks).trim();
        if (!text) continue;

        // Header / Footer kontrolü
        if (headers.has(text)) {
          headerChildren.push(new Paragraph({
            children: [new TextRun({ text, size: Math.round(line.size * 2), font: line.font })],
            alignment: "center"
          }));
          continue;
        }
        if (footers.has(text)) {
          footerChildren.push(new Paragraph({
            children: [new TextRun({ text, size: Math.round(line.size * 2), font: line.font })],
            alignment: "center"
          }));
          continue;
        }

        // X koordinatından sol margin'i çıkar (Word'e göreceli girinti)
        const lineIndent = Math.max(0, line.x - (marginLeft / 20));

        if (currentParaText === '') {
          currentParaText = text;
          currentParaStyle = line;
          currentParaIndent = lineIndent;
          currentParaSpacing = line.spacingToNext;
        } else {
          currentParaText += ' ' + text;
          if (isSentenceEnd(text)) {
            pushParagraph();
          }
        }
      }
      pushParagraph();

      sections.push({
        properties: {
          page: {
            size: { width: w * 20, height: h * 20 },
            margin: { 
              top: marginTop, 
              bottom: marginBottom, 
              left: marginLeft, 
              right: marginRight 
            }
          }
        },
        headers: headerChildren.length ? { default: new Header({ children: headerChildren }) } : undefined,
        footers: footerChildren.length ? { default: new Footer({ children: footerChildren }) } : undefined,
        children: children
      });
    }

    const doc = new Document({ creator: 'PDF Atölyesi', sections: sections });
    const blob = await Packer.toBlob(doc);
    downloadBlob(blob, S.name.replace(/\.pdf$/i, '') + '.docx');
    toast('Word belgesi başarıyla indirildi.');
  } catch (e) {
    console.error(e);
    toast('Word dönüştürme hatası: ' + (e.message || 'bilinmeyen hata'), true);
  } finally {
    btn.disabled = false;
  }
}

// Header/Footer Tespiti
function detectHeadersFooters(allPagesData) {
  if (allPagesData.length <= 1) return { headers: new Set(), footers: new Set() };
  
  const headers = new Set();
  const footers = new Set();
  
  const firstPage = allPagesData[0];
  if (!firstPage.lines.length) return { headers, footers };
  
  const h = firstPage.h;
  const headerLimit = h * 0.15;
  const footerLimit = h * 0.85;
  
  const potentialHeaders = allPagesData.map(p => 
    p.lines.filter(l => l.y < headerLimit).map(l => mergeLineText(l.blocks).trim()).filter(Boolean)
  );
  const potentialFooters = allPagesData.map(p => 
    p.lines.filter(l => l.y > footerLimit).map(l => mergeLineText(l.blocks).trim()).filter(Boolean)
  );

  const countOccurrences = (text, arr) => arr.filter(pageTexts => pageTexts.includes(text)).length;
  
  if (potentialHeaders.length > 1) {
    for (const text of potentialHeaders[0]) {
      if (countOccurrences(text, potentialHeaders) >= allPagesData.length * 0.7) headers.add(text);
    }
  }
  if (potentialFooters.length > 1) {
    for (const text of potentialFooters[0]) {
      if (countOccurrences(text, potentialFooters) >= allPagesData.length * 0.7) footers.add(text);
    }
  }
  return { headers, footers };
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

(function bindConvertButtons() {
  const bind = () => {
    const w = document.getElementById('toWord');
    const x = document.getElementById('toExcel');
    if (w) w.onclick = exportToWord;
    if (x) x.onclick = () => toast('Excel dönüştürücü şu an yapım aşamasında.', true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();