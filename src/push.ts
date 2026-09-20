import { api } from "./api";

export type PushState = "loading" | "ios-install" | "unsupported" | "default" | "denied" | "granted";

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function currentPushState(): PushState {
  if (!pushSupported()) return isIOS() && !isStandalone() ? "ios-install" : "unsupported";
  return Notification.permission as PushState;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** İzin ister, abone olur ve aboneliği sunucuya kaydeder. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission as PushState;
  await syncSubscription(true);
  return "granted";
}

/** İzin zaten verilmişse aboneliği (uç nokta değişmiş olabilir) sunucuyla eşitler. */
export async function syncSubscription(createIfMissing = false) {
  if (!pushSupported() || Notification.permission !== "granted") {
    await api.registerDevice();
    return;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && createIfMissing) {
    const { vapidPublicKey } = await api.config();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(vapidPublicKey),
    });
  }
  await api.registerDevice(sub ? sub.toJSON() : undefined);
}
