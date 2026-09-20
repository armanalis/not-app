import { asLang, t, type Lang } from "../shared/i18n";
import type { Repeat } from "../shared/schedule";
import type { ListSettings, Todo } from "../shared/types";

const DEVICE_KEY = "deviceId";
const LANG_KEY = "lang";

export function getLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored) return asLang(stored);
  } catch {
    // depolama kapalı olabilir
  }
  return navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function setLang(lang: Lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // yoksay
  }
}

export function getDeviceId(): string {
  let id: string | null = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
  } catch {
    // depolama kapalı olabilir
  }
  if (!id || !/^[a-f0-9]{32}$/.test(id)) {
    id = crypto.randomUUID().replaceAll("-", "");
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      // yoksay
    }
  }
  return id;
}

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-device-id": getDeviceId(),
      "x-lang": getLang(),
      ...init.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || t(getLang(), "errRequest", { status: res.status }));
  }
  return data as T;
}

export type TodoPatch = {
  title?: string;
  deadline?: number | null;
  repeat?: Repeat;
  done?: boolean;
  snoozeMinutes?: number;
};

export const api = {
  config: () => request<{ vapidPublicKey: string }>("/api/config"),
  registerDevice: (subscription?: PushSubscriptionJSON | null) =>
    request<{ settings: ListSettings; deviceCount: number }>("/api/device", {
      method: "POST",
      body: JSON.stringify({ tz: timeZone(), subscription, lang: getLang() }),
    }),
  testPush: () => request<{ result: string }>("/api/test-push", { method: "POST" }),
  list: () => request<Todo[]>("/api/todos"),
  create: (title: string, deadline: number | null, repeat: Repeat) =>
    request<Todo>("/api/todos", { method: "POST", body: JSON.stringify({ title, deadline, repeat }) }),
  update: (id: string, patch: TodoPatch) =>
    request<Todo>(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => request(`/api/todos/${id}`, { method: "DELETE" }),
  saveSettings: (patch: Partial<ListSettings>) =>
    request<{ settings: ListSettings; todos: Todo[] }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  pairCode: () => request<{ code: string; expiresAt: number }>("/api/pair/code", { method: "POST" }),
  pairJoin: (code: string) =>
    request<{ settings: ListSettings; todos: Todo[] }>("/api/pair/join", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
};
