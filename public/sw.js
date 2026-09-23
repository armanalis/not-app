// Service worker: push bildirimlerini gösterir ve uygulamayı çevrimdışı çalıştırır.

// Sürüm değişince eski önbellek silinir.
const CACHE = "reminder-app-v1";
// Uygulama kabuğu. Hash'li varlıklar ilk ziyarette kendiliğinden eklenir.
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Ağ önce, başarılıysa önbelleğe yaz; ağ yoksa önbellekten ver. */
async function networkFirst(request, fallbackKey) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE);
      cache.put(fallbackKey || request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(fallbackKey || request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sayfa açılışı: ağ yoksa önbellekteki kabuk.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  // Not listesi: çevrimdışıyken en son kaydedilen hâli göster.
  if (url.pathname === "/api/todos") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Diğer API çağrıları önbelleğe alınmaz; çevrimdışıyken başarısız olmalı.
  if (url.pathname.startsWith("/api/")) return;

  // Statik varlıklar: önbellekte varsa oradan, yoksa ağdan alıp sakla.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        }),
    ),
  );
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Hatırlatıcı", body: event.data ? event.data.text() : "" };
  }
  const data = payload.data || {};
  const options = {
    body: payload.body || "",
    tag: payload.tag,
    renotify: Boolean(payload.tag),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data,
    actions: Array.isArray(payload.actions) ? payload.actions : [],
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || "Hatırlatıcı", options),
      notifyClients({ type: "refresh" }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  const { todoId, deviceId, url } = event.notification.data || {};
  event.notification.close();

  const patch = (body) =>
    fetch(`/api/todos/${todoId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-device-id": deviceId },
      body: JSON.stringify(body),
    })
      .then(() => notifyClients({ type: "refresh" }))
      .catch(() => {});

  if (todoId && deviceId) {
    if (event.action === "done") return event.waitUntil(patch({ done: true }));
    if (event.action === "snooze15") return event.waitUntil(patch({ snoozeMinutes: 15 }));
    if (event.action === "snooze60") return event.waitUntil(patch({ snoozeMinutes: 60 }));
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) return existing.focus();
      return self.clients.openWindow(url || "/");
    }),
  );
});

async function notifyClients(message) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of windows) w.postMessage(message);
}
