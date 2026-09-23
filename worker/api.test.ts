// API uçlarını gerçek bir yerel D1 üzerinde test eder (miniflare).
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { HOUR } from "../shared/schedule";
import type { Todo } from "../shared/types";
import worker, { cleanUp } from "./index";

let env: Env;
let dispose: () => Promise<void>;

const device = (n: number) => n.toString(16).padStart(32, "0");

/** Migration dosyalarını sırayla uygular. */
async function applyMigrations() {
  for (const file of readdirSync("migrations").sort()) {
    const sql = readFileSync(`migrations/${file}`, "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
      await env.DB.prepare(stmt).run();
    }
  }
}

async function call<T = unknown>(
  method: string,
  path: string,
  opts: { deviceId?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
  const req = new Request(`https://test.local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-lang": "en",
      ...(opts.deviceId === undefined ? {} : { "x-device-id": opts.deviceId }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  // Testte üretilen Request, worker'ın beklediği "gelen istek" tipini taşımaz.
  const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], env);
  return { status: res.status, data: (await res.json()) as T };
}

const addTodo = async (deviceId: string, body: Record<string, unknown>) =>
  (await call<Todo>("POST", "/api/todos", { deviceId, body })).data;

beforeAll(async () => {
  const proxy = await getPlatformProxy<Env>({ persist: false });
  env = proxy.env;
  dispose = proxy.dispose;
  await applyMigrations();
});

afterAll(() => dispose());

describe("kimlik doğrulama", () => {
  it("device id yoksa 400", async () => {
    expect((await call("GET", "/api/todos")).status).toBe(400);
  });

  it("geçersiz biçimli device id 400", async () => {
    expect((await call("GET", "/api/todos", { deviceId: "kisa" })).status).toBe(400);
  });

  it("/api/config device id istemez", async () => {
    const r = await call<{ vapidPublicKey: string }>("GET", "/api/config");
    expect(r.status).toBe(200);
    expect(r.data.vapidPublicKey).toBeTruthy();
  });
});

describe("not oluşturma", () => {
  const d = device(1);

  it("başlık boşsa 400", async () => {
    expect((await call("POST", "/api/todos", { deviceId: d, body: { title: "  " } })).status).toBe(400);
  });

  it("tarihsiz not kabul edilir ve listede görünür", async () => {
    const todo = await addTodo(d, { title: "süt al" });
    expect(todo.title).toBe("süt al");
    expect(todo.deadline).toBeNull();
    expect(todo.nextNotifyAt).toBeGreaterThan(Date.now());

    const list = await call<Todo[]>("GET", "/api/todos", { deviceId: d });
    expect(list.data.map((x) => x.title)).toContain("süt al");
  });

  it("seçilen saat ilk bildirim anı olur", async () => {
    const at = Date.now() + 3 * HOUR;
    const todo = await addTodo(d, { title: "toplantı", deadline: at, notifyAt: at });
    expect(todo.nextNotifyAt).toBe(at);
  });

  it("geçersiz tekrar sıklığı 400", async () => {
    const r = await call("POST", "/api/todos", { deviceId: d, body: { title: "x", notifyEveryHours: 999 } });
    expect(r.status).toBe(400);
  });

  it("tarihsiz nota tekrar konamaz", async () => {
    const r = await call("POST", "/api/todos", { deviceId: d, body: { title: "x", repeat: "daily" } });
    expect(r.status).toBe(400);
  });

  it("başka cihazın listesi ayrıdır", async () => {
    const list = await call<Todo[]>("GET", "/api/todos", { deviceId: device(2) });
    expect(list.data).toHaveLength(0);
  });
});

describe("not güncelleme", () => {
  const d = device(3);

  it("tamamlanan tekrarlı görev bir sonraki güne atlar", async () => {
    const deadline = Date.now() + HOUR;
    const todo = await addTodo(d, { title: "ilaç", deadline, repeat: "daily" });
    const r = await call<Todo>("PATCH", `/api/todos/${todo.id}`, { deviceId: d, body: { done: true } });
    expect(r.data.done).toBe(false);
    expect(r.data.deadline).toBeGreaterThan(deadline);
  });

  it("erteleme bir sonraki bildirimi öteler", async () => {
    const todo = await addTodo(d, { title: "ertele" });
    const r = await call<Todo>("PATCH", `/api/todos/${todo.id}`, { deviceId: d, body: { snoozeMinutes: 60 } });
    expect(r.data.nextNotifyAt).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  it("başka cihazın notu güncellenemez", async () => {
    const todo = await addTodo(d, { title: "gizli" });
    const r = await call("PATCH", `/api/todos/${todo.id}`, { deviceId: device(4), body: { done: true } });
    expect(r.status).toBe(404);
  });

  it("silme çalışır", async () => {
    const todo = await addTodo(d, { title: "silinecek" });
    expect((await call("DELETE", `/api/todos/${todo.id}`, { deviceId: d })).status).toBe(200);
    expect((await call("PATCH", `/api/todos/${todo.id}`, { deviceId: d, body: {} })).status).toBe(404);
  });
});

describe("elle sıralama", () => {
  const d = device(5);

  it("tarihsiz notlar yukarı taşınabilir", async () => {
    await addTodo(d, { title: "A" });
    const b = await addTodo(d, { title: "B" });
    const r = await call<{ todos: Todo[] }>("PATCH", `/api/todos/${b.id}`, { deviceId: d, body: { move: "up" } });
    expect(r.data.todos.map((x) => x.title)).toEqual(["B", "A"]);
  });

  it("listenin başındaki notu yukarı taşımak bir şeyi bozmaz", async () => {
    const list = await call<Todo[]>("GET", "/api/todos", { deviceId: d });
    const first = list.data[0];
    const r = await call<{ todos: Todo[] }>("PATCH", `/api/todos/${first.id}`, {
      deviceId: d,
      body: { move: "up" },
    });
    expect(r.data.todos[0].id).toBe(first.id);
  });

  it("tarihli not elle sıralanamaz", async () => {
    const dated = await addTodo(d, { title: "tarihli", deadline: Date.now() + HOUR });
    const r = await call("PATCH", `/api/todos/${dated.id}`, { deviceId: d, body: { move: "up" } });
    expect(r.status).toBe(400);
  });
});

describe("kurtarma kodu", () => {
  const owner = device(6);
  const fresh = device(7);

  it("aynı liste için hep aynı kodu döner", async () => {
    const first = await call<{ code: string }>("POST", "/api/recovery", { deviceId: owner });
    const again = await call<{ code: string }>("POST", "/api/recovery", { deviceId: owner });
    expect(first.data.code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
    expect(again.data.code).toBe(first.data.code);
  });

  it("geçersiz kod reddedilir", async () => {
    expect((await call("POST", "/api/recovery/use", { deviceId: fresh, body: { code: "abc" } })).status).toBe(400);
    const wrong = await call("POST", "/api/recovery/use", { deviceId: fresh, body: { code: "0".repeat(16) } });
    expect(wrong.status).toBe(400);
  });

  it("kodla yeni cihaz listeye döner", async () => {
    await addTodo(owner, { title: "kurtarılacak" });
    const { data } = await call<{ code: string }>("POST", "/api/recovery", { deviceId: owner });
    const r = await call<{ todos: Todo[] }>("POST", "/api/recovery/use", { deviceId: fresh, body: { code: data.code } });
    expect(r.status).toBe(200);
    expect(r.data.todos.map((x) => x.title)).toContain("kurtarılacak");
  });

  it("zaten o listedeyse reddedilir", async () => {
    const { data } = await call<{ code: string }>("POST", "/api/recovery", { deviceId: owner });
    const r = await call("POST", "/api/recovery/use", { deviceId: owner, body: { code: data.code } });
    expect(r.status).toBe(400);
  });
});

describe("notu başka listeye taşıma", () => {
  const from = device(8);
  const to = device(9);

  it("hedef listenin koduyla taşınır", async () => {
    const { data: target } = await call<{ code: string }>("POST", "/api/recovery", { deviceId: to });
    const todo = await addTodo(from, { title: "taşınacak" });

    const r = await call<{ todos: Todo[] }>("POST", `/api/todos/${todo.id}/move`, {
      deviceId: from,
      body: { code: target.code },
    });
    expect(r.status).toBe(200);
    expect(r.data.todos.map((x) => x.title)).not.toContain("taşınacak");

    const arrived = await call<Todo[]>("GET", "/api/todos", { deviceId: to });
    expect(arrived.data.map((x) => x.title)).toContain("taşınacak");
  });

  it("kendi listesine taşımak reddedilir", async () => {
    const { data: own } = await call<{ code: string }>("POST", "/api/recovery", { deviceId: from });
    const todo = await addTodo(from, { title: "yerinde" });
    const r = await call(`POST`, `/api/todos/${todo.id}/move`, { deviceId: from, body: { code: own.code } });
    expect(r.status).toBe(400);
  });
});

describe("temizlik", () => {
  it("uzun süredir açılmamış cihazı ve notlarını siler", async () => {
    const old = device(10);
    await addTodo(old, { title: "eski not" });
    const ancient = Date.now() - 365 * 24 * HOUR;
    await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(ancient, old).run();

    await cleanUp(env);

    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").bind(old).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM todos WHERE title = 'eski not'").first<{
      n: number;
    }>();
    expect(orphans?.n).toBe(0);
  });

  it("aktif cihaza dokunmaz", async () => {
    const live = device(11);
    await addTodo(live, { title: "duran not" });
    await cleanUp(env);
    const list = await call<Todo[]>("GET", "/api/todos", { deviceId: live });
    expect(list.data.map((x) => x.title)).toContain("duran not");
  });
});
