# Hatırlatıcı

**English** · [Türkçe](README.tr.md)

A PWA that sends push notifications for your todos. Runs free on Cloudflare Workers + D1.

Live: https://not-app.armanalis.workers.dev

## Running locally

```bash
npm install
cp .dev.vars.example .dev.vars
npm run vapid      # first time only: generates VAPID keys (.dev.vars + wrangler.jsonc)
npm run db:local   # local database tables
npm run dev        # http://localhost:5173
```

Trigger the cron by hand: `curl http://localhost:5173/cdn-cgi/handler/scheduled`

Tests: `npm test`

## Deploying (one-time setup)

1. `npx wrangler login`
2. `npx wrangler d1 create not-app-db` → copy the returned `database_id` into `wrangler.jsonc`
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

The table above is the default. Each note can override it from the add form or the edit sheet:

- **Reminder time** — pick an exact moment for the first reminder. It fires precisely then, and quiet hours do not hold it back. Once it has passed, the note falls back to its repeat interval (or the table).
- **Repeat every** — a fixed interval (1, 2, 3, 6, 12 or 24 hours) instead of the escalating tiers. Quiet hours still apply, so an interval landing at night moves to the morning.

Leave both on **Automatic** and the note behaves exactly as the table describes. Neither needs a deadline — a note with no due date can still have an exact reminder time.

## Language and theme

The settings panel offers Türkçe / English and System / Light / Dark. On first launch it follows the browser language.

The language choice covers notification text too: the device's language is stored in the `devices.lang` column, and the cron sends the notification in that language. All strings live in one place, `shared/i18n.ts`.

## Known limits

- On iPhone, notifications require Safari → Share → **Add to Home Screen** (iOS 16.4+).
- Notes are tied to the device (there is no login system).
- The cron sends at most 40 notifications per minute (free-plan request limit).
