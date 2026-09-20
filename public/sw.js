// Service worker: sunucudan gelen push'ları bildirim olarak gösterir.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
