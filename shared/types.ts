import type { Intensity, Repeat } from "./schedule";

export type Todo = {
  id: string;
  title: string;
  deadline: number | null;
  repeat: Repeat;
  done: boolean;
  nextNotifyAt: number | null;
  createdAt: number;
};

export type ListSettings = {
  quietStart: number;
  quietEnd: number;
  intensity: Intensity;
};
