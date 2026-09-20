import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  HOUR,
  MINUTE,
  catchUpOccurrence,
  intervalFor,
  nextNotifyAt,
  nextOccurrence,
  normalizeEveryHours,
  normalizeSettings,
  reminderBody,
} from "./schedule";

const TZ = "Europe/Istanbul"; // UTC+3, yaz saati yok
const S = { ...DEFAULT_SETTINGS, tz: TZ };
// İstanbul yerel saatini UTC timestamp'e çevirir.
const ist = (day: number, h: number, m = 0) => Date.UTC(2026, 8, day, h - 3, m);

describe("intervalFor", () => {
  it("normal kademeler", () => {
    expect(intervalFor(null)).toBe(2 * HOUR);
    expect(intervalFor(10 * HOUR)).toBe(2 * HOUR);
    expect(intervalFor(6 * HOUR)).toBe(HOUR);
    expect(intervalFor(2 * HOUR)).toBe(30 * MINUTE);
    expect(intervalFor(30 * MINUTE)).toBe(10 * MINUTE);
    expect(intervalFor(-5 * MINUTE)).toBe(2 * HOUR);
  });

  it("sakin ve ısrarcı profiller", () => {
    expect(intervalFor(10 * HOUR, "calm")).toBe(4 * HOUR);
    expect(intervalFor(20 * MINUTE, "calm")).toBe(30 * MINUTE);
    expect(intervalFor(10 * HOUR, "insistent")).toBe(HOUR);
    expect(intervalFor(20 * MINUTE, "insistent")).toBe(5 * MINUTE);
  });
});

describe("nextNotifyAt", () => {
  it("deadline yoksa 2 saat sonra", () => {
    expect(nextNotifyAt(null, ist(16, 10), S)).toBe(ist(16, 12));
  });

  it("10 saat kala 2 saat, 3 saat kala 1 saat sonra", () => {
    expect(nextNotifyAt(ist(16, 20), ist(16, 10), S)).toBe(ist(16, 12));
    expect(nextNotifyAt(ist(16, 18), ist(16, 15), S)).toBe(ist(16, 16));
  });

  it("son 30 dk'da 10 dk'da bir", () => {
    expect(nextNotifyAt(ist(16, 18), ist(16, 17, 35), S)).toBe(ist(16, 17, 45));
  });

  it("aralık deadline'ı geçiyorsa deadline anında bildirir", () => {
    expect(nextNotifyAt(ist(16, 18), ist(16, 17, 55), S)).toBe(ist(16, 18));
  });

  it("süre geçtiyse 2 saatte bir", () => {
    expect(nextNotifyAt(ist(16, 18), ist(16, 18), S)).toBe(ist(16, 20));
  });

  it("sessiz saate düşen bildirim 08:00'e kayar", () => {
    expect(nextNotifyAt(null, ist(16, 22), S)).toBe(ist(17, 8));
    expect(nextNotifyAt(null, ist(17, 2), S)).toBe(ist(17, 8));
  });

  it("deadline gece içindeyse 30 dk önce tek bildirim, sonra sessiz saat sonu", () => {
    const deadline = ist(17, 2);
    const first = nextNotifyAt(deadline, ist(16, 22, 30), S);
    expect(first).toBe(ist(17, 1, 30));
    expect(nextNotifyAt(deadline, first, S)).toBe(ist(17, 8));
  });

  it("sessiz saatler kullanıcı ayarına göre uygulanır", () => {
    const custom = { ...S, quietStart: 1, quietEnd: 6 };
    expect(nextNotifyAt(null, ist(16, 22), custom)).toBe(ist(17, 0));
    expect(nextNotifyAt(null, ist(17, 0, 30), custom)).toBe(ist(17, 6));
  });

  it("sessiz saat kapalıysa (başlangıç = bitiş) gece de bildirir", () => {
    const off = { ...S, quietStart: 0, quietEnd: 0 };
    expect(nextNotifyAt(null, ist(16, 23), off)).toBe(ist(17, 1));
  });

  it("farklı saat diliminde sessiz saati yerel saate göre uygular", () => {
    // 15 Eyl New York 22:00 (EDT, UTC-4) → 00:00 sessiz → 16 Eyl 08:00 NY = 12:00 UTC
    expect(nextNotifyAt(null, Date.UTC(2026, 8, 16, 2), { ...S, tz: "America/New_York" })).toBe(
      Date.UTC(2026, 8, 16, 12),
    );
  });

  it("geçersiz saat dilimi UTC'ye düşer", () => {
    expect(nextNotifyAt(null, Date.UTC(2026, 8, 16, 10), { ...S, tz: "Mars/Base" })).toBe(Date.UTC(2026, 8, 16, 12));
  });
});

describe("nextOccurrence", () => {
  it("günlük ve haftalık", () => {
    expect(nextOccurrence(ist(16, 9), "daily", TZ)).toBe(ist(17, 9));
    expect(nextOccurrence(ist(16, 9), "weekly", TZ)).toBe(ist(23, 9));
  });

  it("hafta içi cumadan pazartesiye atlar", () => {
    // 18 Eylül 2026 cuma
    expect(nextOccurrence(ist(18, 9), "weekdays", TZ)).toBe(ist(21, 9));
  });

  it("yaz saati geçişinde yerel saat korunur", () => {
    // Berlin'de yaz saati 25 Ekim 2026'da biter
    const before = Date.UTC(2026, 9, 24, 7); // 09:00 yerel (UTC+2)
    const after = nextOccurrence(before, "daily", "Europe/Berlin");
    expect(new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(after)).toBe("09:00");
  });

  it("geçmiş tekrarları bugüne taşır", () => {
    expect(catchUpOccurrence(ist(10, 9), "daily", ist(16, 12), TZ)).toBe(ist(17, 9));
  });
});

describe("normalizeSettings", () => {
  it("geçersiz değerleri varsayılana çevirir", () => {
    expect(normalizeSettings({ tz: "Mars/Base", quietStart: 99, quietEnd: -1, intensity: "loud" as never })).toEqual({
      tz: "UTC",
      quietStart: 23,
      quietEnd: 8,
      intensity: "normal",
    });
  });
});

describe("reminderBody", () => {
  it("İngilizce metinler", () => {
    expect(reminderBody(null, ist(16, 10), TZ, "en")).toContain("still on your list");
    expect(reminderBody(ist(16, 18), ist(16, 15, 45), TZ, "en")).toBe("⏳ 2 h 15 min left · due 18:00");
    expect(reminderBody(ist(16, 18), ist(16, 20), TZ, "en")).toContain("Overdue");
  });

  it("metinler", () => {
    expect(reminderBody(null, ist(16, 10), TZ)).toContain("Hatırlatma");
    expect(reminderBody(ist(16, 18), ist(16, 15, 45), TZ)).toBe("⏳ 2 sa 15 dk kaldı · son: 18:00");
    expect(reminderBody(ist(16, 18), ist(16, 18), TZ)).toContain("şimdi doldu");
    expect(reminderBody(ist(16, 18), ist(16, 20), TZ)).toContain("Gecikti");
  });
});

describe("normalizeEveryHours", () => {
  it("1-168 saat arası tam sayıları kabul eder", () => {
    expect(normalizeEveryHours(3)).toBe(3);
    expect(normalizeEveryHours(168)).toBe(168);
    expect(normalizeEveryHours(0)).toBeNull();
    expect(normalizeEveryHours(169)).toBeNull();
    expect(normalizeEveryHours(1.5)).toBeNull();
    expect(normalizeEveryHours("3")).toBeNull();
    expect(normalizeEveryHours(null)).toBeNull();
  });
});

describe("nextNotifyAt — nota özel kural", () => {
  it("seçilen kesin saati aynen kullanır", () => {
    expect(nextNotifyAt(null, ist(16, 10), S, { notifyAt: ist(16, 14, 30) })).toBe(ist(16, 14, 30));
  });

  it("kesin saat sessiz saatte olsa bile ertelenmez", () => {
    expect(nextNotifyAt(null, ist(16, 20), S, { notifyAt: ist(17, 3) })).toBe(ist(17, 3));
  });

  it("kesin saat geçtiyse yok sayılır, sabit aralığa düşer", () => {
    expect(nextNotifyAt(null, ist(16, 15), S, { notifyAt: ist(16, 10), everyHours: 3 })).toBe(ist(16, 18));
  });

  it("sabit aralık kademeli kuralın yerine geçer", () => {
    // Kademeli olsaydı 30 dk'da 1 olurdu; sabit aralık 6 saat.
    expect(nextNotifyAt(ist(16, 11), ist(16, 10), S, { everyHours: 6 })).toBe(ist(16, 11));
    expect(nextNotifyAt(null, ist(16, 10), S, { everyHours: 6 })).toBe(ist(16, 16));
  });

  it("sabit aralık sessiz saate denk gelirse sabaha kayar", () => {
    expect(nextNotifyAt(null, ist(16, 22), S, { everyHours: 3 })).toBe(ist(17, 8));
  });

  it("kural boşsa kademeli davranış değişmez", () => {
    expect(nextNotifyAt(null, ist(16, 10), S, {})).toBe(nextNotifyAt(null, ist(16, 10), S));
  });
});
