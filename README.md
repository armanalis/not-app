# Hatırlatıcı

**English** · [Türkçe](README.tr.md)

A PWA that sends push notifications for your todos. Runs free on Cloudflare Workers + D1.

Live: https://reminder-app.armanalis.workers.dev

## Running locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run vapid      # first time only: generates VAPID keys (.dev.vars + wrangler.jsonc)
npm run db:local   # local database tables
npm run dev        # http://localhost:5173
```

Trigger the cron by hand: `curl http://localhost:5173/cdn-cgi/handler/scheduled`

Tests: `npm test` — scheduling rules plus the API endpoints, which run against a real local D1.

## Deploying (one-time setup)

1. `npx wrangler login`
2. `npx wrangler d1 create reminder-app-db` → copy the returned `database_id` into `wrangler.jsonc`
3. `npm run db:remote`
4. `npx wrangler secret put VAPID_PRIVATE_KEY` → paste the value from `.dev.vars` (without quotes)
5. `npm run deploy`

After that, updates are just `npm run deploy`.

## Notification schedule

| Time remaining | Frequency |
|---|---|
| No deadline / > 6 hours | every 2 hours |
| 6 – 2 hours | hourly |
| 2 hours – 30 min | every 30 min |
| < 30 min | every 10 min + at the deadline |
| Overdue | every 2 hours |

Quiet from 23:00–08:00 (in the user's own timezone). The rule lives in `shared/schedule.ts`.

### Per-note overrides

The table above is the default. Each note can change it from the add form or the edit sheet:

- **Date and time** — when a note has a date, the first reminder fires exactly at that moment. Quiet hours don't hold it back. There are no earlier escalating reminders before it.
- **Repeat every** — a fixed interval (1, 2, 3, 6, 12 or 24 hours) instead of the escalating tiers. Quiet hours still apply, so an interval landing at night moves to the morning.

Notes without a date, and older notes whose date hasn't been changed, follow the table.

## Language and theme

The settings panel offers Türkçe / English and System / Light / Dark. On first launch it follows the browser language.

The language choice covers notification text too: the device's language is stored in the `devices.lang` column, and the cron sends the notification in that language. All strings live in one place, `shared/i18n.ts`.

## Keeping and finding notes

**Recovery code.** Settings → Recovery code gives a permanent 16-character code for your list. Entering it on another device moves that device onto the list. It is the way back in if you lose the phone or clear browser data — without it, a cleared `deviceId` means the notes are unreachable.

**Search.** A search box appears once a list passes five notes and filters on the title.

**Order.** Dated notes are always sorted by time. Undated ones can be moved up and down from the edit sheet.

**Moving a note.** The edit sheet takes another list's recovery code and moves that single note there.

## Offline

The service worker caches the app shell and the last `/api/todos` response. Opening the app without a connection shows that saved list with a banner. Other API calls fail as usual, so nothing is written while offline. Bump `CACHE` in `public/sw.js` when the shell changes.

## Housekeeping

Once a day at 03:17 UTC the cron also deletes devices unseen for 180 days, then any list and note left without a device.

## Known limits

- On iPhone, notifications require Safari → Share → **Add to Home Screen** (iOS 16.4+).
- Notes are tied to the device (there is no login system); the recovery code is the only way back to them.
- The cron sends at most 40 notifications per minute (free-plan request limit).
