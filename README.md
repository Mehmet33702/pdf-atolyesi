# PDF Atölyesi

Tarayıcıda çalışan, sunucu gerektirmeyen PDF görüntüleyici ve düzenleyici. Dosyalarınız cihazınızdan çıkmaz; tüm işlemler tarayıcıda yapılır.

**Canlı sürüm:** https://mehmet33702.github.io/pdf-atolyesi/

## Özellikler

* **Görüntüleme:** Sürekli kaydırma, yakınlaştırma, ekrana sığdırma, mobil uyumlu arayüz ve otomatik açık/koyu tema.
* **Çizim ve Not:** Metin ekleme, vurgulama, serbest çizim, dikdörtgen ve renk seçilebilir kapama kutusu.
* **Sayfa Yönetimi:** Döndürme, silme, yukarı/aşağı taşıma.
* **Metin Düzenleme (Düzenle):** Aktif sayfadaki metin kutularını Türkçe OCR (Tesseract.js) ile tarar. Kutuya tıklayarak veya bölge çizerek yazı tipi, boyut, kalın, italik, yazı ve otomatik algılanan zemin rengiyle canlı önizlemeli düzenleme yapılabilir. Dijital PDF'lerde yazı stili otomatik algılanır.
* **Kaydetme ve Geri Alma:** `Ctrl+Z` ile geri alma; `Kaydet` (`-duzenlendi.pdf`) ve `Farklı Kaydet` (`-kopya.pdf`) ile yerel indirme.

## Kurulum ve Yayınlama

Derleme gerektirmez. Dosyaları doğrudan GitHub Pages üzerinde yayınlayabilirsiniz:

```text
index.html
style.css
app.js
ocr.js
manifest.json   # (PWA için isteğe bağlı)
icon.svg        # (PWA için isteğe bağlı)
sw.js           # (PWA için isteğe bağlı)
```

Yerelde test etmek için proje klasöründe basit bir sunucu başlatmanız yeterlidir:

```bash
python -m http.server 8000
```

## Kısayollar

| Kısayol | İşlev |
| :--- | :--- |
| `Ctrl+Z` / `Cmd+Z` | Geri al |
| `Ctrl+Enter` | Metin düzenlemeyi uygula |
| `Esc` | Metin düzenlemeyi iptal et |

## Gizlilik ve Sınırlamalar

* PDF dosyaları hiçbir sunucuya yüklenmez. Yalnızca kütüphaneler (cdnjs, jsDelivr), yazı tipi (Google Fonts) ve OCR dil modeli (`tessdata.projectnaptha.com`) tarayıcı tarafından CDN'den indirilir.
* Metin değiştirme ve beyaz kutu **gerçek redaksiyon değildir**; orijinal metin katmanı dosyada kalır. Gizli verileri silmek için kullanmayın.
* Eklenen metin ve çizimler sayfaya PNG katmanı olarak gömülür (seçilemez); kapama kutuları vektör olarak çizilir.
* Parola korumalı veya bozuk PDF'ler açılamaz.

## Kullanılan Kütüphaneler ve Lisans

* [PDF.js 3.11.174](https://mozilla.github.io/pdf.js/) (Apache-2.0)
* [pdf-lib 1.17.1](https://pdf-lib.js.org/) (MIT)
* [Tesseract.js 5.x](https://tesseract.projectnaptha.com/) (Apache-2.0)
* [IBM Plex Sans](https://fonts.google.com/specimen/IBM+Plex+Sans) (SIL OFL 1.1)

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır.
