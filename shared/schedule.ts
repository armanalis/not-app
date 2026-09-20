// Bildirim zamanlama kuralları. Hem worker (cron) hem arayüz tarafından kullanılır.
import { localeOf, t, type Lang } from "./i18n";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export type Intensity = "calm" | "normal" | "insistent";
export type Repeat = "daily" | "weekdays" | "weekly" | null;

/** Bir notun kendi bildirim tercihi. Boş alanlar kademeli varsayılana düşer. */
export type NotifyRule = {
  /** Kullanıcının seçtiği ilk bildirim anı. Geçmişte kaldıysa yok sayılır. */
  notifyAt?: number | null;
  /** Sabit tekrar aralığı (saat). Yoksa kalan süreye göre kademelenir. */
  everyHours?: number | null;
};

/** Arayüzdeki "kaç saatte bir" seçenekleri. */
export const EVERY_HOURS_CHOICES = [1, 2, 3, 6, 12, 24] as const;
export const MAX_EVERY_HOURS = 168; // 1 hafta

export function normalizeEveryHours(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_EVERY_HOURS ? v : null;
}

export type Settings = {
  tz: string;
  quietStart: number; // yerel saat, 0-23
  quietEnd: number; // yerel saat, 0-23
  intensity: Intensity;
};

export const DEFAULT_SETTINGS: Settings = { tz: "UTC", quietStart: 23, quietEnd: 8, intensity: "normal" };

/** Kalan süre kademelerine göre bildirim aralıkları. */
const TIERS: Record<Intensity, { far: number; mid: number; near: number; last: number }> = {
  //         > 6 saat      6-2 saat      2 sa-30 dk    < 30 dk
  calm: { far: 4 * HOUR, mid: 2 * HOUR, near: HOUR, last: 30 * MINUTE },
  normal: { far: 2 * HOUR, mid: HOUR, near: 30 * MINUTE, last: 10 * MINUTE },
  insistent: { far: HOUR, mid: 30 * MINUTE, near: 15 * MINUTE, last: 5 * MINUTE },
};

export function intervalFor(remainingMs: number | null, intensity: Intensity = "normal"): number {
  const tier = TIERS[intensity] ?? TIERS.normal;
  if (remainingMs === null || remainingMs <= 0) return tier.far;
  if (remainingMs <= 30 * MINUTE) return tier.last;
  if (remainingMs <= 2 * HOUR) return tier.near;
  if (remainingMs <= 6 * HOUR) return tier.mid;
  return tier.far;
}

export function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function normalizeSettings(s: Partial<Settings> | null | undefined): Settings {
  const hour = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23 ? v : fallback;
  return {
    tz: safeTimeZone(s?.tz),
    quietStart: hour(s?.quietStart, DEFAULT_SETTINGS.quietStart),
    quietEnd: hour(s?.quietEnd, DEFAULT_SETTINGS.quietEnd),
    intensity: s?.intensity && s.intensity in TIERS ? s.intensity : "normal",
  };
}

function localParts(ts: number, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(ts)) p[part.type] = part.value;
  return {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    h: +p.hour,
    min: +p.minute,
    s: +p.second,
    weekday: p.weekday, // "Mon" … "Sun"
  };
}

function tzOffset(ts: number, tz: string): number {
  const p = localParts(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - (ts - (((ts % 1000) + 1000) % 1000));
}

function localTimeToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

export function isQuietHour(ts: number, s: Settings): boolean {
  if (s.quietStart === s.quietEnd) return false;
  const { h } = localParts(ts, s.tz);
  return s.quietStart < s.quietEnd ? h >= s.quietStart && h < s.quietEnd : h >= s.quietStart || h < s.quietEnd;
}

/** ts sessiz saatteyse, o sessiz aralığın bittiği an. */
export function quietEnd(ts: number, s: Settings): number {
  const p = localParts(ts, s.tz);
  const wrapped = s.quietStart > s.quietEnd && p.h >= s.quietStart;
  return localTimeToUtc(p.y, p.m, p.d + (wrapped ? 1 : 0), s.quietEnd, 0, s.tz);
}

/** `after` anından sonra gönderilecek bir sonraki bildirimin zamanı. */
export function nextNotifyAt(
  deadline: number | null,
  after: number,
  settings: Partial<Settings>,
  rule: NotifyRule = {},
): number {
  const s = normalizeSettings(settings);

  // Kullanıcı kesin bir saat seçtiyse o saat aynen kullanılır; sessiz saat bile bozmaz.
  if (rule.notifyAt != null && rule.notifyAt > after) return rule.notifyAt;

  const everyHours = normalizeEveryHours(rule.everyHours);
  let next: number;
  if (everyHours !== null) {
    next = after + everyHours * HOUR;
    // Deadline aralığın içine düşüyorsa o anda da bir bildirim gitsin.
    if (deadline !== null && deadline > after && deadline < next) next = deadline;
  } else if (deadline === null || after >= deadline) {
    next = after + intervalFor(null, s.intensity);
  } else {
    // Deadline anında da bir bildirim gitsin.
    next = Math.min(after + intervalFor(deadline - after, s.intensity), deadline);
  }

  if (!isQuietHour(next, s)) return next;

  const end = quietEnd(next, s);
  if (deadline !== null && deadline > after && deadline < end) {
    // Deadline gece içinde: 30 dk önce tek bir istisna bildirimi.
    const reminder = deadline - 30 * MINUTE;
    if (reminder > after) return reminder;
  }
  return end;
}

/** Tekrarlayan görev için bir sonraki tarih (yerel saat korunur). */
export function nextOccurrence(deadline: number, repeat: Exclude<Repeat, null>, tz: string): number {
  const zone = safeTimeZone(tz);
  const step = (ts: number, days: number) => {
    const p = localParts(ts, zone);
    return localTimeToUtc(p.y, p.m, p.d + days, p.h, p.min, zone);
  };
  if (repeat === "weekly") return step(deadline, 7);
  let next = step(deadline, 1);
  if (repeat === "weekdays") {
    while (["Sat", "Sun"].includes(localParts(next, zone).weekday)) next = step(next, 1);
  }
  return next;
}

/** Geçmişte kalmış tekrarlayan bir görevi bugüne taşır. */
export function catchUpOccurrence(deadline: number, repeat: Exclude<Repeat, null>, now: number, tz: string): number {
  let next = deadline;
  for (let i = 0; i < 400 && next <= now; i++) next = nextOccurrence(next, repeat, tz);
  return next;
}

export function formatDuration(ms: number, lang: Lang = "tr"): string {
  const totalMin = Math.max(1, Math.round(Math.abs(ms) / MINUTE));
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  const unit =
    lang === "en"
      ? { d: days === 1 ? "day" : "days", h: "h", m: "min" }
      : { d: "gün", h: "sa", m: "dk" };
  const parts: string[] = [];
  if (days) parts.push(`${days} ${unit.d}`);
  if (hours) parts.push(`${hours} ${unit.h}`);
  if (mins && !days) parts.push(`${mins} ${unit.m}`);
  return parts.join(" ") || `1 ${unit.m}`;
}

export function dayKey(ts: number, tz: string): string {
  const p = localParts(ts, safeTimeZone(tz));
  return `${p.y}-${p.m}-${p.d}`;
}

export function formatClock(ts: number, tz: string, now = Date.now(), lang: Lang = "tr"): string {
  const zone = safeTimeZone(tz);
  const locale = localeOf(lang);
  const time = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "2-digit", minute: "2-digit" }).format(ts);
  if (dayKey(ts, zone) === dayKey(now, zone)) return time;
  if (dayKey(ts, zone) === dayKey(now + 24 * HOUR, zone)) return `${lang === "en" ? "tomorrow" : "yarın"} ${time}`;
  const date = new Intl.DateTimeFormat(locale, { timeZone: zone, day: "numeric", month: "short" }).format(ts);
  return `${date} ${time}`;
}

/** Bildirim gövdesi. */
export function reminderBody(deadline: number | null, now: number, tz: string, lang: Lang = "tr"): string {
  if (deadline === null) return t(lang, "pushNoDeadline");
  const diff = deadline - now;
  if (Math.abs(diff) <= MINUTE) return t(lang, "pushDueNow");
  if (diff < 0) return t(lang, "pushOverdue", { d: formatDuration(diff, lang) });
  return t(lang, "pushRemaining", { d: formatDuration(diff, lang), clock: formatClock(deadline, tz, now, lang) });
}
