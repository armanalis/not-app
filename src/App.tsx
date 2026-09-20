import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LANGS, LANG_LABELS, t as translate, type Lang } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  HOUR,
  MINUTE,
  dayKey,
  formatClock,
  formatDuration,
  type Intensity,
  type Repeat,
} from "../shared/schedule";
import type { ListSettings, Todo } from "../shared/types";
import { api, getLang, setLang, timeZone, type TodoPatch } from "./api";
import { currentPushState, enablePush, isIOS, syncSubscription, type PushState } from "./push";
import { applyTheme, getTheme, type Theme } from "./theme";

const DEFAULT_LIST_SETTINGS: ListSettings = {
  quietStart: DEFAULT_SETTINGS.quietStart,
  quietEnd: DEFAULT_SETTINGS.quietEnd,
  intensity: DEFAULT_SETTINGS.intensity,
};

type Sheet = { kind: "edit"; todo: Todo } | { kind: "settings" } | null;
type T = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => string;

const toLocalInput = (ts: number) => new Date(ts - new Date(ts).getTimezoneOffset() * MINUTE).toISOString().slice(0, 16);

const atHour = (daysAhead: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

/** Bugün 18:00 geçtiyse yarın 18:00. */
const eveningPreset = () => (new Date().getHours() >= 18 ? atHour(1, 18) : atHour(0, 18));

export default function App() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [settings, setSettings] = useState<ListSettings>(DEFAULT_LIST_SETTINGS);
  const [deviceCount, setDeviceCount] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pushState, setPushState] = useState<PushState>("loading");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [lang, setLangState] = useState<Lang>(getLang);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const tz = useMemo(timeZone, []);
  const t: T = useCallback((key, params) => translate(lang, key, params), [lang]);

  const refresh = useCallback(async () => {
    try {
      setTodos(await api.list());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = translate(lang, "appTitle");
  }, [lang]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const state = currentPushState();
    setPushState(state);
    api
      .registerDevice()
      .then((r) => {
        setSettings(r.settings);
        setDeviceCount(r.deviceCount);
      })
      .catch(() => {});
    syncSubscription(state === "granted").catch((err) => console.error(err));
    refresh();

    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        refresh();
      }
    };
    const onMessage = (e: MessageEvent) => e.data?.type === "refresh" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      setNotice(null);
    }
  };

  const active = (todos ?? []).filter((x) => !x.done);
  const done = (todos ?? []).filter((x) => x.done);
  const groups = groupByDay(active, now, tz, t);
  const overdue = active.filter((x) => x.deadline !== null && x.deadline <= now).length;

  const patch = (id: string, p: TodoPatch) =>
    run(async () => {
      const updated = await api.update(id, p);
      setTodos((prev) => (prev ?? []).map((x) => (x.id === updated.id ? updated : x)));
      setSheet((s) => (s?.kind === "edit" && s.todo.id === updated.id ? { kind: "edit", todo: updated } : s));
    });

  const remove = (id: string) =>
    run(async () => {
      await api.remove(id);
      setTodos((prev) => (prev ?? []).filter((x) => x.id !== id));
      setSheet(null);
    });

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>{t("appTitle")}</h1>
          <p className="subtitle">
            {todos === null
              ? t("loading")
              : active.length === 0
                ? t("allClear")
                : overdue > 0
                  ? t("countOverdue", { n: active.length, k: overdue })
                  : t("countActive", { n: active.length })}
          </p>
        </div>
        <button className="icon-btn" onClick={() => setSheet({ kind: "settings" })} aria-label={t("settings")}>
          ⚙
        </button>
      </header>

      <NotificationCard
        state={pushState}
        t={t}
        onEnable={() =>
          run(async () => {
            setPushState(await enablePush());
          })
        }
      />

      <AddForm
        t={t}
        onAdd={(title, deadline, repeat) =>
          run(async () => {
            const todo = await api.create(title, deadline, repeat);
            setTodos((prev) => [...(prev ?? []), todo]);
          })
        }
      />

      {notice && !error && <p className="notice">{notice}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {todos !== null && active.length === 0 && <p className="empty">{t("emptyHint")}</p>}

      {groups.map(([label, items]) => (
        <section className="group" key={label}>
          <h2 className="group-title">{label}</h2>
          <ul className="list">
            {items.map((x) => (
              <TodoCard
                key={x.id}
                todo={x}
                now={now}
                tz={tz}
                lang={lang}
                t={t}
                onToggle={() => patch(x.id, { done: true })}
                onOpen={() => setSheet({ kind: "edit", todo: x })}
              />
            ))}
          </ul>
        </section>
      ))}

      {done.length > 0 && (
        <details className="done">
          <summary>{t("doneSection", { n: done.length })}</summary>
          <ul className="list">
            {done.map((x) => (
              <TodoCard
                key={x.id}
                todo={x}
                now={now}
                tz={tz}
                lang={lang}
                t={t}
                onToggle={() => patch(x.id, { done: false })}
                onOpen={() => setSheet({ kind: "edit", todo: x })}
              />
            ))}
          </ul>
        </details>
      )}

      {sheet?.kind === "edit" && (
        <SheetShell title={t("editTitle")} t={t} onClose={() => setSheet(null)}>
          <EditSheet
            todo={sheet.todo}
            tz={tz}
            now={now}
            lang={lang}
            t={t}
            onPatch={(p) => patch(sheet.todo.id, p)}
            onDelete={() => remove(sheet.todo.id)}
            onClose={() => setSheet(null)}
          />
        </SheetShell>
      )}

      {sheet?.kind === "settings" && (
        <SheetShell title={t("settings")} t={t} onClose={() => setSheet(null)}>
          <SettingsSheet
            settings={settings}
            deviceCount={deviceCount}
            pushState={pushState}
            lang={lang}
            theme={theme}
            t={t}
            onLang={(l) => {
              setLang(l);
              setLangState(l);
              api.registerDevice().catch(() => {});
            }}
            onTheme={(th) => setThemeState(th)}
            onSave={(patchBody) =>
              run(async () => {
                const r = await api.saveSettings(patchBody);
                setSettings(r.settings);
                setTodos(r.todos);
              })
            }
            onTest={() =>
              run(async () => {
                setNotice(null);
                try {
                  await api.testPush();
                } catch {
                  await syncSubscription(true);
                  await api.testPush();
                }
                setNotice(t("testSent"));
                setSheet(null);
              })
            }
            onPaired={(r) => {
              setSettings(r.settings);
              setTodos(r.todos);
              setNotice(t("pairedOk"));
              setSheet(null);
            }}
            onError={(msg) => setError(msg)}
          />
        </SheetShell>
      )}
    </div>
  );
}

function groupByDay(todos: Todo[], now: number, tz: string, t: T): [string, Todo[]][] {
  const today = dayKey(now, tz);
  const tomorrow = dayKey(now + 24 * HOUR, tz);
  const keys = ["groupOverdue", "groupToday", "groupTomorrow", "groupLater", "groupUndated"] as const;
  const buckets: Record<(typeof keys)[number], Todo[]> = {
    groupOverdue: [],
    groupToday: [],
    groupTomorrow: [],
    groupLater: [],
    groupUndated: [],
  };
  for (const todo of todos) {
    if (todo.deadline === null) buckets.groupUndated.push(todo);
    else if (todo.deadline <= now) buckets.groupOverdue.push(todo);
    else if (dayKey(todo.deadline, tz) === today) buckets.groupToday.push(todo);
    else if (dayKey(todo.deadline, tz) === tomorrow) buckets.groupTomorrow.push(todo);
    else buckets.groupLater.push(todo);
  }
  return keys.filter((k) => buckets[k].length > 0).map((k) => [t(k), buckets[k]]);
}

function urgencyOf(todo: Todo, now: number): "late" | "soon" | "today" | "calm" {
  if (todo.deadline === null) return "calm";
  const left = todo.deadline - now;
  if (left <= 0) return "late";
  if (left <= 2 * HOUR) return "soon";
  if (left <= 12 * HOUR) return "today";
  return "calm";
}

function TodoCard({
  todo,
  now,
  tz,
  lang,
  t,
  onToggle,
  onOpen,
}: {
  todo: Todo;
  now: number;
  tz: string;
  lang: Lang;
  t: T;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const urgency = urgencyOf(todo, now);
  const left = todo.deadline === null ? null : todo.deadline - now;
  // Kalan süre çubuğu en fazla son 12 saati gösterir.
  const span = todo.deadline === null ? 0 : Math.min(12 * HOUR, todo.deadline - todo.createdAt);
  const progress = left === null || span <= 0 ? null : Math.max(0, Math.min(1, 1 - left / span));

  return (
    <li className={`card ${todo.done ? "is-done" : ""} u-${urgency}`}>
      <button
        className={`check ${todo.done ? "on" : ""}`}
        onClick={onToggle}
        aria-label={todo.done ? t("undo") : t("markDone")}
      >
        {todo.done ? "✓" : ""}
      </button>

      <button className="card-body" onClick={onOpen}>
        <span className="card-title">{todo.title}</span>
        <span className="card-meta">
          {todo.deadline !== null && (
            <span className="when">
              {left !== null && left <= 0
                ? t("overdueBy", { d: formatDuration(left, lang) })
                : t("remaining", {
                    clock: formatClock(todo.deadline, tz, now, lang),
                    d: formatDuration(left ?? 0, lang),
                  })}
            </span>
          )}
          {todo.repeat && <span className="tag">🔁&nbsp;{t(todo.repeat)}</span>}
          {!todo.done && todo.nextNotifyAt !== null && (
            <span className="tag">🔔&nbsp;{formatClock(Math.max(todo.nextNotifyAt, now), tz, now, lang)}</span>
          )}
        </span>
        {progress !== null && progress > 0.03 && !todo.done && (
          <span className="bar" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
        )}
      </button>
    </li>
  );
}

function NotificationCard({ state, t, onEnable }: { state: PushState; t: T; onEnable: () => void }) {
  if (state === "loading" || state === "granted") return null;

  if (state === "ios-install") {
    return (
      <div className="banner">
        <strong>{t("iosTitle")}</strong>
        <ol>
          <li>{t("iosStep1")}</li>
          <li>{t("iosStep2")}</li>
          <li>{t("iosStep3")}</li>
        </ol>
      </div>
    );
  }

  if (state === "unsupported") {
    return (
      <div className="banner">
        {t("unsupported")} {isIOS() ? t("unsupportedIOS") : t("unsupportedOther")}
      </div>
    );
  }

  if (state === "denied") return <div className="banner">{t("denied")}</div>;

  return (
    <div className="banner banner-cta">
      <span>{t("ctaText")}</span>
      <button className="primary" onClick={onEnable}>
        {t("enableBtn")}
      </button>
    </div>
  );
}

function DeadlinePicker({
  value,
  t,
  onChange,
}: {
  value: number | null;
  t: T;
  onChange: (v: number | null) => void;
}) {
  const presets: { label: string; value: number | null }[] = [
    { label: t("noDate"), value: null },
    { label: t("inOneHour"), value: Date.now() + HOUR },
    { label: new Date().getHours() >= 18 ? t("tomorrowEvening") : t("todayEvening"), value: eveningPreset() },
    { label: t("tomorrowMorning"), value: atHour(1, 9) },
  ];
  const selected = (p: number | null) => (p === null ? value === null : value !== null && Math.abs(p - value) < MINUTE);

  return (
    <>
      <div className="chips">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`chip ${selected(p.value) ? "on" : ""}`}
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {value !== null && (
        <input
          className="date-input"
          type="datetime-local"
          value={toLocalInput(value)}
          onChange={(e) => {
            const ts = new Date(e.target.value).getTime();
            if (!Number.isNaN(ts)) onChange(ts);
          }}
          aria-label={t("dateTimeAria")}
        />
      )}
    </>
  );
}

function RepeatPicker({
  value,
  disabled,
  t,
  onChange,
}: {
  value: Repeat;
  disabled: boolean;
  t: T;
  onChange: (v: Repeat) => void;
}) {
  const options: { label: string; value: Repeat }[] = [
    { label: t("noRepeat"), value: null },
    { label: t("daily"), value: "daily" },
    { label: t("weekdays"), value: "weekdays" },
    { label: t("weekly"), value: "weekly" },
  ];
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          disabled={disabled && o.value !== null}
          className={`chip ${value === o.value ? "on" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AddForm({
  t,
  onAdd,
}: {
  t: T;
  onAdd: (title: string, deadline: number | null, repeat: Repeat) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [deadline, setDeadline] = useState<number | null>(null);
  const [repeat, setRepeat] = useState<Repeat>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    await onAdd(title.trim(), deadline, deadline === null ? null : repeat);
    setBusy(false);
    setTitle("");
    setDeadline(null);
    setRepeat(null);
    setOpen(false);
  };

  return (
    <form className="add" onSubmit={submit}>
      <div className="add-row">
        <input
          className="add-input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder={t("addPlaceholder")}
          maxLength={200}
          aria-label={t("todoAria")}
          enterKeyHint="done"
        />
        <button className="primary" type="submit" disabled={!title.trim() || busy}>
          {t("addBtn")}
        </button>
      </div>

      {(open || deadline !== null) && (
        <div className="add-options">
          <DeadlinePicker
            value={deadline}
            t={t}
            onChange={(v) => {
              setDeadline(v);
              if (v === null) setRepeat(null);
            }}
          />
          {deadline !== null && <RepeatPicker value={repeat} disabled={false} t={t} onChange={setRepeat} />}
        </div>
      )}
    </form>
  );
}

function SheetShell({
  title,
  t,
  children,
  onClose,
}: {
  title: string;
  t: T;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t("close")}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function EditSheet({
  todo,
  tz,
  now,
  lang,
  t,
  onPatch,
  onDelete,
  onClose,
}: {
  todo: Todo;
  tz: string;
  now: number;
  lang: Lang;
  t: T;
  onPatch: (p: TodoPatch) => Promise<void>;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(todo.title);
  const [deadline, setDeadline] = useState<number | null>(todo.deadline);
  const [repeat, setRepeat] = useState<Repeat>(todo.repeat);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const changed = title.trim() !== todo.title || deadline !== todo.deadline || repeat !== todo.repeat;

  return (
    <div className="sheet-body">
      <input
        className="sheet-input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        aria-label={t("titleAria")}
      />

      <span className="field-label">{t("whenLabel")}</span>
      <DeadlinePicker
        value={deadline}
        t={t}
        onChange={(v) => {
          setDeadline(v);
          if (v === null) setRepeat(null);
        }}
      />

      <span className="field-label">{t("repeatLabel")}</span>
      <RepeatPicker value={repeat} disabled={deadline === null} t={t} onChange={setRepeat} />
      {deadline === null && <p className="hint">{t("needDate")}</p>}

      {!todo.done && (
        <>
          <span className="field-label">{t("snoozeLabel")}</span>
          <div className="chips">
            {[
              { label: t("snooze15"), min: 15 },
              { label: t("snooze60"), min: 60 },
              { label: t("snooze180"), min: 180 },
              { label: t("snoozeMorning"), min: Math.max(15, Math.round((atHour(1, 9) - now) / MINUTE)) },
            ].map((s) => (
              <button
                key={s.label}
                type="button"
                className="chip"
                onClick={async () => {
                  await onPatch({ snoozeMinutes: s.min });
                  onClose();
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {todo.nextNotifyAt && (
            <p className="hint">
              {t("nextNotify", { clock: formatClock(Math.max(todo.nextNotifyAt, now), tz, now, lang) })}
            </p>
          )}
        </>
      )}

      <div className="sheet-actions">
        {confirmDelete ? (
          <button className="danger" onClick={onDelete}>
            {t("confirmDelete")}
          </button>
        ) : (
          <button className="ghost" onClick={() => setConfirmDelete(true)}>
            {t("delete")}
          </button>
        )}
        <button
          className="primary"
          disabled={!changed || !title.trim()}
          onClick={async () => {
            await onPatch({ title: title.trim(), deadline, repeat });
            onClose();
          }}
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
}

function SettingsSheet({
  settings,
  deviceCount,
  pushState,
  lang,
  theme,
  t,
  onLang,
  onTheme,
  onSave,
  onTest,
  onPaired,
  onError,
}: {
  settings: ListSettings;
  deviceCount: number;
  pushState: PushState;
  lang: Lang;
  theme: Theme;
  t: T;
  onLang: (l: Lang) => void;
  onTheme: (th: Theme) => void;
  onSave: (p: Partial<ListSettings>) => Promise<void>;
  onTest: () => void;
  onPaired: (r: { settings: ListSettings; todos: Todo[] }) => void;
  onError: (msg: string) => void;
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [input, setInput] = useState("");
  const quietOn = settings.quietStart !== settings.quietEnd;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const intensities: Intensity[] = ["calm", "normal", "insistent"];
  const themes: Theme[] = ["system", "light", "dark"];
  const themeLabel: Record<Theme, string> = {
    system: t("themeSystem"),
    light: t("themeLight"),
    dark: t("themeDark"),
  };

  return (
    <div className="sheet-body">
      <span className="field-label">{t("languageLabel")}</span>
      <div className="chips">
        {LANGS.map((l) => (
          <button key={l} type="button" className={`chip ${lang === l ? "on" : ""}`} onClick={() => onLang(l)}>
            {LANG_LABELS[l]}
          </button>
        ))}
      </div>

      <span className="field-label">{t("themeLabel")}</span>
      <div className="chips">
        {themes.map((th) => (
          <button key={th} type="button" className={`chip ${theme === th ? "on" : ""}`} onClick={() => onTheme(th)}>
            {themeLabel[th]}
          </button>
        ))}
      </div>

      <span className="field-label">{t("frequencyLabel")}</span>
      <div className="chips">
        {intensities.map((i) => (
          <button
            key={i}
            type="button"
            className={`chip ${settings.intensity === i ? "on" : ""}`}
            onClick={() => onSave({ intensity: i })}
          >
            {t(i)}
          </button>
        ))}
      </div>
      <p className="hint">
        {settings.intensity === "calm" && t("freqHintCalm")}
        {settings.intensity === "normal" && t("freqHintNormal")}
        {settings.intensity === "insistent" && t("freqHintInsistent")}
      </p>

      <span className="field-label">{t("quietLabel")}</span>
      <div className="quiet-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={quietOn}
            onChange={(e) =>
              onSave(e.target.checked ? { quietStart: 23, quietEnd: 8 } : { quietStart: 0, quietEnd: 0 })
            }
          />
          <span>{t("quietOn")}</span>
        </label>
        {quietOn && (
          <>
            <select value={settings.quietStart} onChange={(e) => onSave({ quietStart: +e.target.value })}>
              {hours.map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
              ))}
            </select>
            <span>–</span>
            <select value={settings.quietEnd} onChange={(e) => onSave({ quietEnd: +e.target.value })}>
              {hours.map((h) => (
                <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>
              ))}
            </select>
          </>
        )}
      </div>
      <p className="hint">{t("quietHint")}</p>

      <span className="field-label">{t("devicesLabel", { n: deviceCount })}</span>
      <p className="hint">{t("pairHint")}</p>
      <div className="pair">
        <button
          className="ghost"
          onClick={async () => {
            try {
              setCode(await api.pairCode());
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          {t("createCode")}
        </button>
        {code && <strong className="pair-code">{code.code}</strong>}
      </div>
      {code && <p className="hint">{t("codeHint")}</p>}
      <div className="pair">
        <input
          className="pair-input"
          inputMode="numeric"
          maxLength={6}
          placeholder={t("enterCode")}
          value={input}
          onChange={(e) => setInput(e.target.value.replace(/\D/g, ""))}
          aria-label={t("codeAria")}
        />
        <button
          className="ghost"
          disabled={input.length !== 6}
          onClick={async () => {
            try {
              onPaired(await api.pairJoin(input));
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          {t("connect")}
        </button>
      </div>

      {pushState === "granted" && (
        <div className="sheet-actions">
          <span className="ok">🔔&nbsp;{t("pushOn")}</span>
          <button className="ghost" onClick={onTest}>
            {t("sendTest")}
          </button>
        </div>
      )}
    </div>
  );
}
