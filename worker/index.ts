import {
  MINUTE,
  catchUpOccurrence,
  nextNotifyAt,
  nextOccurrence,
  normalizeEveryHours,
  normalizeSettings,
  reminderBody,
  safeTimeZone,
  type NotifyRule,
  type Repeat,
  type Settings,
} from "../shared/schedule";
import { asLang, t, type Lang } from "../shared/i18n";
import type { ListSettings, Todo } from "../shared/types";
import { sendPush } from "./push";

// Ücretsiz planda bir çalıştırmada en fazla 50 dış istek yapılabilir.
const PUSH_BATCH = 40;
const MAX_TODOS_PER_LIST = 300;
const MAX_TITLE = 200;
const PAIR_CODE_TTL = 10 * MINUTE;

type TodoRow = {
  id: string;
  title: string;
  deadline: number | null;
  repeat: string | null;
  done: number;
  notify_at: number | null;
  notify_every_h: number | null;
  next_notify_at: number | null;
  created_at: number;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const newId = () => crypto.randomUUID().replaceAll("-", "");

const parseRepeat = (v: unknown): Repeat | undefined => {
  if (v === null || v === undefined) return null;
  return v === "daily" || v === "weekdays" || v === "weekly" ? v : undefined;
};

const toTodo = (r: TodoRow): Todo => ({
  id: r.id,
  title: r.title,
  deadline: r.deadline,
  repeat: (r.repeat as Repeat) ?? null,
  done: r.done === 1,
  notifyAt: r.notify_at,
  notifyEveryHours: r.notify_every_h,
  nextNotifyAt: r.done === 1 ? null : r.next_notify_at,
  createdAt: r.created_at,
});

const ruleOf = (t: { notifyAt: number | null; notifyEveryHours: number | null }): NotifyRule => ({
  notifyAt: t.notifyAt,
  everyHours: t.notifyEveryHours,
});

function validDeviceId(id: string | null): id is string {
  return !!id && /^[a-f0-9]{32}$/.test(id);
}

function parseDeadline(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  return undefined;
}

/** Kesin bildirim saati: null = kademeli varsayılan. */
const parseNotifyAt = parseDeadline;

/** Sabit tekrar aralığı: null = kademeli varsayılan. */
function parseEveryHours(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return normalizeEveryHours(v) ?? undefined;
}

type ListRow = { id: string; tz: string; quiet_start: number; quiet_end: number; intensity: string };

const rowToSettings = (l: { tz: string; quiet_start: number; quiet_end: number; intensity: string }): Settings =>
  normalizeSettings({ tz: l.tz, quietStart: l.quiet_start, quietEnd: l.quiet_end, intensity: l.intensity as never });

/** Cihazı (ve listesini) oluşturur ya da tazeler, liste ayarlarını döner. */
async function ensureDevice(env: Env, deviceId: string, tz?: string): Promise<{ listId: string; settings: Settings }> {
  const now = Date.now();
  const zone = tz ? safeTimeZone(tz) : null;
  const existing = await env.DB.prepare("SELECT list_id FROM devices WHERE id = ?")
    .bind(deviceId)
    .first<{ list_id: string | null }>();

  let listId = existing?.list_id ?? null;
  if (!listId) {
    listId = newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO lists (id, tz, created_at) VALUES (?, ?, ?)").bind(listId, zone ?? "UTC", now),
      env.DB.prepare(
        `INSERT INTO devices (id, tz, created_at, last_seen_at, list_id) VALUES (?1, ?2, ?3, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET last_seen_at = ?3, list_id = ?4`,
      ).bind(deviceId, zone ?? "UTC", now, listId),
    ]);
  } else {
    await env.DB.prepare("UPDATE devices SET last_seen_at = ?, tz = COALESCE(?, tz) WHERE id = ?")
      .bind(now, zone, deviceId)
      .run();
    if (zone) await env.DB.prepare("UPDATE lists SET tz = ? WHERE id = ?").bind(zone, listId).run();
  }

  const list = await env.DB.prepare("SELECT * FROM lists WHERE id = ?").bind(listId).first<ListRow>();
  return { listId, settings: list ? rowToSettings(list) : normalizeSettings({ tz: zone ?? "UTC" }) };
}

async function getTodo(env: Env, listId: string, id: string) {
  const row = await env.DB.prepare("SELECT * FROM todos WHERE id = ? AND list_id = ?").bind(id, listId).first<TodoRow>();
  return row ? toTodo(row) : null;
}

const listTodos = async (env: Env, listId: string) => {
  const { results } = await env.DB.prepare(
    "SELECT * FROM todos WHERE list_id = ? ORDER BY done, COALESCE(deadline, 9e15), created_at",
  )
    .bind(listId)
    .all<TodoRow>();
  return results.map(toTodo);
};

const settingsPayload = (s: Settings): ListSettings => ({
  quietStart: s.quietStart,
  quietEnd: s.quietEnd,
  intensity: s.intensity,
});

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const lang: Lang = asLang(req.headers.get("x-lang"));

  if (path === "/api/config" && req.method === "GET") {
    return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });
  }

  const deviceId = req.headers.get("x-device-id");
  if (!validDeviceId(deviceId)) return json({ error: t(lang, "errDeviceId") }, 400);

  // Cihaz kaydı: saat dilimi ve push aboneliği
  if (path === "/api/device" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { tz?: string; subscription?: unknown; lang?: unknown };
    const { listId, settings } = await ensureDevice(env, deviceId, body.tz);
    if (body.lang !== undefined) {
      await env.DB.prepare("UPDATE devices SET lang = ? WHERE id = ?").bind(asLang(body.lang), deviceId).run();
    }
    if (body.subscription !== undefined) {
      const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
      const valid =
        sub === null ||
        (typeof sub?.endpoint === "string" &&
          sub.endpoint.startsWith("https://") &&
          typeof sub.keys?.p256dh === "string" &&
          typeof sub.keys?.auth === "string");
      if (!valid) return json({ error: t(lang, "errSubscription") }, 400);
      await env.DB.prepare("UPDATE devices SET subscription = ? WHERE id = ?")
        .bind(sub ? JSON.stringify(sub) : null, deviceId)
        .run();
    }
    const devices = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE list_id = ?")
      .bind(listId)
      .first<{ n: number }>();
    return json({ ok: true, settings: settingsPayload(settings), deviceCount: devices?.n ?? 1 });
  }

  if (path === "/api/settings" && req.method === "PATCH") {
    const { listId, settings } = await ensureDevice(env, deviceId);
    const body = (await req.json().catch(() => ({}))) as Partial<ListSettings>;
    const merged = normalizeSettings({ ...settings, ...body });
    if (
      (body.quietStart !== undefined && merged.quietStart !== body.quietStart) ||
      (body.quietEnd !== undefined && merged.quietEnd !== body.quietEnd) ||
      (body.intensity !== undefined && merged.intensity !== body.intensity)
    ) {
      return json({ error: t(lang, "errSettings") }, 400);
    }
    await env.DB.prepare("UPDATE lists SET quiet_start = ?, quiet_end = ?, intensity = ? WHERE id = ?")
      .bind(merged.quietStart, merged.quietEnd, merged.intensity, listId)
      .run();

    // Bekleyen bildirimleri yeni ayarlara göre yeniden zamanla.
    const todos = await listTodos(env, listId);
    const now = Date.now();
    const updates = todos
      .filter((t) => !t.done)
      .map((t) =>
        env.DB.prepare("UPDATE todos SET next_notify_at = ? WHERE id = ?").bind(
          nextNotifyAt(t.deadline, now, merged, ruleOf(t)),
          t.id,
        ),
      );
    if (updates.length) await env.DB.batch(updates);
    return json({ settings: settingsPayload(merged), todos: await listTodos(env, listId) });
  }

  // Eşleştirme: kod üret
  if (path === "/api/pair/code" && req.method === "POST") {
    const { listId } = await ensureDevice(env, deviceId);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + PAIR_CODE_TTL;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pair_codes WHERE list_id = ? OR expires_at < ?").bind(listId, Date.now()),
      env.DB.prepare("INSERT INTO pair_codes (code, list_id, expires_at) VALUES (?, ?, ?)").bind(
        code,
        listId,
        expiresAt,
      ),
    ]);
    return json({ code, expiresAt });
  }

  // Eşleştirme: koda katıl
  if (path === "/api/pair/join" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!/^\d{6}$/.test(code)) return json({ error: t(lang, "errCodeFormat") }, 400);

    const row = await env.DB.prepare("SELECT list_id, expires_at FROM pair_codes WHERE code = ?")
      .bind(code)
      .first<{ list_id: string; expires_at: number }>();
    if (!row || row.expires_at < Date.now()) return json({ error: t(lang, "errCodeInvalid") }, 400);

    const { listId: oldListId } = await ensureDevice(env, deviceId);
    if (row.list_id === oldListId) return json({ error: t(lang, "errAlreadyPaired") }, 400);

    await env.DB.batch([
      // Cihazın mevcut notlarını yeni listeye taşı.
      env.DB.prepare("UPDATE todos SET list_id = ? WHERE list_id = ?").bind(row.list_id, oldListId),
      env.DB.prepare("UPDATE devices SET list_id = ? WHERE id = ?").bind(row.list_id, deviceId),
      env.DB.prepare("DELETE FROM pair_codes WHERE code = ?").bind(code),
      env.DB.prepare(
        "DELETE FROM lists WHERE id = ? AND NOT EXISTS (SELECT 1 FROM devices WHERE list_id = ? AND id != ?)",
      ).bind(oldListId, oldListId, deviceId),
    ]);
    const list = await env.DB.prepare("SELECT * FROM lists WHERE id = ?").bind(row.list_id).first<ListRow>();
    return json({
      ok: true,
      settings: settingsPayload(list ? rowToSettings(list) : normalizeSettings({})),
      todos: await listTodos(env, row.list_id),
    });
  }

  if (path === "/api/test-push" && req.method === "POST") {
    const row = await env.DB.prepare("SELECT subscription FROM devices WHERE id = ?")
      .bind(deviceId)
      .first<{ subscription: string | null }>();
    if (!row?.subscription) return json({ error: t(lang, "errNoSubscription") }, 400);
    const result = await sendPush(env, row.subscription, {
      title: t(lang, "testPushTitle"),
      body: t(lang, "testPushBody"),
      tag: "test",
      data: { url: "/" },
    });
    if (result === "gone") {
      await env.DB.prepare("UPDATE devices SET subscription = NULL WHERE id = ?").bind(deviceId).run();
      return json({ error: t(lang, "errSubscriptionGone") }, 409);
    }
    return json(
      { result, error: result === "sent" ? undefined : t(lang, "errPushFailed") },
      result === "sent" ? 200 : 502,
    );
  }

  if (path === "/api/todos" && req.method === "GET") {
    const { listId } = await ensureDevice(env, deviceId);
    return json(await listTodos(env, listId));
  }

  if (path === "/api/todos" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown;
      deadline?: unknown;
      repeat?: unknown;
      notifyAt?: unknown;
      notifyEveryHours?: unknown;
    };
    const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : "";
    const deadline = parseDeadline(body.deadline ?? null);
    const repeat = parseRepeat(body.repeat);
    const notifyAt = parseNotifyAt(body.notifyAt ?? null);
    const everyHours = parseEveryHours(body.notifyEveryHours);
    if (!title) return json({ error: t(lang, "errTitleEmpty") }, 400);
    if (deadline === undefined) return json({ error: t(lang, "errDeadline") }, 400);
    if (repeat === undefined) return json({ error: t(lang, "errRepeat") }, 400);
    if (repeat && deadline === null) return json({ error: t(lang, "errRepeatNeedsDate") }, 400);
    if (notifyAt === undefined) return json({ error: t(lang, "errNotifyAt") }, 400);
    if (everyHours === undefined) return json({ error: t(lang, "errNotifyEvery") }, 400);

    const { listId, settings } = await ensureDevice(env, deviceId);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM todos WHERE list_id = ?")
      .bind(listId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_TODOS_PER_LIST) return json({ error: t(lang, "errTooMany") }, 400);

    const now = Date.now();
    const id = newId();
    const rule = { notifyAt, everyHours };
    await env.DB.prepare(
      `INSERT INTO todos (id, device_id, list_id, title, deadline, repeat, done, notify_at, notify_every_h, next_notify_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        deviceId,
        listId,
        title,
        deadline,
        repeat,
        notifyAt,
        everyHours,
        nextNotifyAt(deadline, now, settings, rule),
        now,
      )
      .run();
    return json(await getTodo(env, listId, id), 201);
  }

  const match = path.match(/^\/api\/todos\/([a-f0-9]{32})$/);
  if (match) {
    const id = match[1];
    const { listId, settings } = await ensureDevice(env, deviceId);
    const existing = await getTodo(env, listId, id);
    if (!existing) return json({ error: t(lang, "errNotFound") }, 404);

    if (req.method === "DELETE") {
      await env.DB.prepare("DELETE FROM todos WHERE id = ? AND list_id = ?").bind(id, listId).run();
      return json({ ok: true });
    }

    if (req.method === "PATCH") {
      const body = (await req.json().catch(() => ({}))) as {
        title?: unknown;
        deadline?: unknown;
        repeat?: unknown;
        done?: unknown;
        snoozeMinutes?: unknown;
        notifyAt?: unknown;
        notifyEveryHours?: unknown;
      };
      const now = Date.now();

      // Erteleme: sadece bir sonraki bildirimi öteler.
      if (typeof body.snoozeMinutes === "number" && body.snoozeMinutes > 0) {
        const until = now + Math.min(body.snoozeMinutes, 24 * 60) * MINUTE;
        await env.DB.prepare("UPDATE todos SET next_notify_at = ?, done = 0 WHERE id = ? AND list_id = ?")
          .bind(until, id, listId)
          .run();
        return json(await getTodo(env, listId, id));
      }

      const title = typeof body.title === "string" ? body.title.trim().slice(0, MAX_TITLE) : existing.title;
      let deadline = "deadline" in body ? parseDeadline(body.deadline) : existing.deadline;
      const repeat = "repeat" in body ? parseRepeat(body.repeat) : existing.repeat;
      let notifyAt = "notifyAt" in body ? parseNotifyAt(body.notifyAt) : existing.notifyAt;
      const everyHours =
        "notifyEveryHours" in body ? parseEveryHours(body.notifyEveryHours) : existing.notifyEveryHours;
      let done = typeof body.done === "boolean" ? body.done : existing.done;
      if (!title) return json({ error: t(lang, "errTitleEmpty") }, 400);
      if (deadline === undefined) return json({ error: t(lang, "errDeadline") }, 400);
      if (repeat === undefined) return json({ error: t(lang, "errRepeat") }, 400);
      if (notifyAt === undefined) return json({ error: t(lang, "errNotifyAt") }, 400);
      if (everyHours === undefined) return json({ error: t(lang, "errNotifyEvery") }, 400);

      // Tekrarlayan görev tamamlanınca bir sonraki tarihe atlar, listede kalır.
      if (done && repeat && deadline !== null) {
        const rolled = catchUpOccurrence(nextOccurrence(deadline, repeat, settings.tz), repeat, now, settings.tz);
        // Kesin bildirim saati de deadline ile aynı kadar ileri kayar.
        if (notifyAt !== null) notifyAt += rolled - deadline;
        deadline = rolled;
        done = false;
      }

      const scheduleChanged =
        deadline !== existing.deadline ||
        notifyAt !== existing.notifyAt ||
        everyHours !== existing.notifyEveryHours ||
        (existing.done && !done);
      const rule = { notifyAt, everyHours };
      const next = done ? null : scheduleChanged ? nextNotifyAt(deadline, now, settings, rule) : existing.nextNotifyAt;
      await env.DB.prepare(
        `UPDATE todos SET title = ?, deadline = ?, repeat = ?, done = ?, notify_at = ?, notify_every_h = ?,
         next_notify_at = ? WHERE id = ? AND list_id = ?`,
      )
        .bind(title, deadline, repeat, done ? 1 : 0, notifyAt, everyHours, next, id, listId)
        .run();
      return json(await getTodo(env, listId, id));
    }
  }

  return json({ error: t(lang, "errNotFound") }, 404);
}

type DueRow = TodoRow & { list_id: string; tz: string; quiet_start: number; quiet_end: number; intensity: string };

async function sendDueReminders(env: Env) {
  const now = Date.now();
  const { results: due } = await env.DB.prepare(
    `SELECT t.*, l.id AS list_id, l.tz, l.quiet_start, l.quiet_end, l.intensity
     FROM todos t JOIN lists l ON l.id = t.list_id
     WHERE t.done = 0 AND t.next_notify_at <= ?
       AND EXISTS (SELECT 1 FROM devices d WHERE d.list_id = t.list_id AND d.subscription IS NOT NULL)
     ORDER BY t.next_notify_at LIMIT ?`,
  )
    .bind(now, PUSH_BATCH)
    .all<DueRow>();
  if (!due.length) return;

  // Listedeki tüm abone cihazlara gönderilir.
  const listIds = [...new Set(due.map((t) => t.list_id))];
  const { results: devices } = await env.DB.prepare(
    `SELECT id, list_id, subscription, lang FROM devices WHERE subscription IS NOT NULL AND list_id IN (${listIds
      .map(() => "?")
      .join(",")})`,
  )
    .bind(...listIds)
    .all<{ id: string; list_id: string; subscription: string; lang: string }>();

  const byList = new Map<string, { id: string; subscription: string; lang: string }[]>();
  for (const d of devices) byList.set(d.list_id, [...(byList.get(d.list_id) ?? []), d]);

  const goneDevices = new Set<string>();
  const updates: D1PreparedStatement[] = [];
  let sentCount = 0;

  await Promise.all(
    due.map(async (todo) => {
      const targets = (byList.get(todo.list_id) ?? []).slice(0, 5);
      const settings = rowToSettings(todo);
      await Promise.all(
        targets.map(async (d) => {
          if (sentCount >= PUSH_BATCH) return;
          sentCount++;
          const deviceLang = asLang(d.lang);
          const result = await sendPush(env, d.subscription, {
            title: todo.title,
            body: reminderBody(todo.deadline, now, settings.tz, deviceLang),
            tag: todo.id,
            data: { todoId: todo.id, deviceId: d.id, url: "/" },
            actions: [
              { action: "done", title: t(deviceLang, "actionDone") },
              { action: "snooze15", title: t(deviceLang, "actionSnooze15") },
              { action: "snooze60", title: t(deviceLang, "actionSnooze60") },
            ],
          });
          if (result === "gone") goneDevices.add(d.id);
        }),
      );
      // Başarısız olsa da sonraki zamana geçilir; aksi halde her dakika tekrar denenir.
      updates.push(
        env.DB.prepare("UPDATE todos SET next_notify_at = ?, last_notified_at = ? WHERE id = ?").bind(
          // notify_at geçtiyse kendiliğinden devre dışı kalır; sonrası sabit aralık ya da kademeli kural.
          nextNotifyAt(todo.deadline, now, settings, { notifyAt: todo.notify_at, everyHours: todo.notify_every_h }),
          now,
          todo.id,
        ),
      );
    }),
  );

  for (const id of goneDevices) {
    updates.push(env.DB.prepare("UPDATE devices SET subscription = NULL WHERE id = ?").bind(id));
  }
  updates.push(env.DB.prepare("DELETE FROM pair_codes WHERE expires_at < ?").bind(now));
  await env.DB.batch(updates);
  console.log(`reminders: ${due.length} todos, ${sentCount} pushes, ${goneDevices.size} expired devices`);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (err) {
        console.error(err);
        return json({ error: t(asLang(req.headers.get("x-lang")), "errServer") }, 500);
      }
    }
    return new Response(null, { status: 404 });
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(sendDueReminders(env));
  },
} satisfies ExportedHandler<Env>;
