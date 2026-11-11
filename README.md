# Heon Jewelry → ChatGPT ürün akışı

heonjewelry.com'daki (Shopify) bütün aktif ürünleri **3 saatte bir** okuyup ChatGPT Business'ın
istediği biçimde tek bir CSV dosyasına yazar. ChatGPT Business Hub bu dosyayı "Barındırılan URL"
olarak kendisi çeker.

- Akış adresi: https://heonjewelry-stack.github.io/heon-chatgpt-feed/feed.csv
- Biçim: https://developers.openai.com/commerce/specs/file-upload/products
- Shopify'a **hiçbir şey yazmaz**, yalnızca okur (Heon Claude uygulaması).
- Satır = varyant (renk/uzunluk/beden). `group_id` = ürün. Fiyatlar USD (ABD fiyatı).
- Görseller Shopify CDN'den JPEG'e çevrilmiş adreslerle gider (`format=jpg`).
- Sitede taslağa çekilen/silinen ürün 15 gün `is_eligible_search=false` ile kalır, sonra düşer
  (OpenAI, akıştan düşen ürünü 14 gün tutuyor). Kayıt: `state/removed.json`.
- Ayda bir `state/heartbeat.txt` yazılır: açık depolarda GitHub 60 gün hareketsiz zamanlamayı durdurur.

## Nereye bakılır
- Son çalışma: GitHub > Actions. Hata olursa GitHub hesabın e-postasına bildirir.
- Son sayım: `state/last-run.json` (ürün, satır, sorunlu satır).

## Elle çalıştırma
- GitHub > Actions > "Shopify → ChatGPT ürün akışı" > Run workflow.
- Yerelde: `node build.mjs` (anahtarlar `~/.heon/.env`'den).

## Gizli anahtarlar (Settings > Secrets > Actions)
`SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` — `~/.heon/.env`'den doğrudan aktarıldı.
Shopify secret'ı yenilenirse (Dev Dashboard > Heon Claude) buradaki de güncellenmeli
(heon-reviews-sync ile aynı).
