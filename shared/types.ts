import type { Intensity, Repeat } from "./schedule";

export type Todo = {
  id: string;
  title: string;
  deadline: number | null;
  repeat: Repeat;
  done: boolean;
  /** Elle sıralama; yalnızca tarihsiz notlarda görünür etkisi var. */
  sortOrder: number;
  /** Kullanıcının seçtiği ilk bildirim anı; yoksa kademeli kural. */
  notifyAt: number | null;
  /** Sabit tekrar aralığı (saat); yoksa kademeli kural. */
  notifyEveryHours: number | null;
  nextNotifyAt: number | null;
  createdAt: number;
};

export type ListSettings = {
  quietStart: number;
  quietEnd: number;
  intensity: Intensity;
};
