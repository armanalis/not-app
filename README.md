# Hatırlatıcı

Yapılacaklar için push bildirimi gönderen PWA. Cloudflare Workers + D1 üzerinde ücretsiz çalışır.

## Yerelde çalıştırma

```bash
npm install
npm run vapid      # ilk seferde: VAPID anahtarları (.dev.vars + wrangler.jsonc)
npm run db:local   # yerel veritabanı tabloları
npm run dev        # http://localhost:5173
```

Cron'u elle tetiklemek için: `curl http://localhost:5173/cdn-cgi/handler/scheduled`

Testler: `npm test`

## Yayına alma (bir kerelik)

1. `npx wrangler login`
2. `npx wrangler d1 create not-app-db` → çıkan `database_id`'yi `wrangler.jsonc` içine yaz
3. `npm run db:remote`
4. `npx wrangler secret put VAPID_PRIVATE_KEY` → `.dev.vars` içindeki değeri (tırnaklar olmadan) yapıştır
5. `npm run deploy`

Sonraki güncellemeler için sadece `npm run deploy`.

## Bildirim kuralı

| Kalan süre | Sıklık |
|---|---|
| Deadline yok / > 6 saat | 2 saatte 1 |
| 6 – 2 saat | saatte 1 |
| 2 saat – 30 dk | 30 dk'da 1 |
| < 30 dk | 10 dk'da 1 + deadline anında |
| Süre geçti | 2 saatte 1 |

23:00–08:00 sessiz (kullanıcının saat dilimine göre). Kural: `shared/schedule.ts`.

## Dil ve tema

Ayarlar panelinden Türkçe / English ve Sistem / Açık / Koyu seçilir. İlk açılışta tarayıcı diline göre başlar.
Dil seçimi bildirim metinlerini de kapsar: cihazın dili `devices.lang` sütununda saklanır, cron bildirimi o dilde gönderir.
Metinler `shared/i18n.ts` içinde tek yerde durur.

## Bilinen sınırlar

- iPhone'da bildirim için Safari → Paylaş → **Ana Ekrana Ekle** gerekir (iOS 16.4+).
- Notlar cihaza bağlıdır (giriş sistemi yok).
- Cron dakikada en fazla 40 bildirim gönderir (ücretsiz plan istek sınırı).
