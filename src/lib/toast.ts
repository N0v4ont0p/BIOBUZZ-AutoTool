import { writable } from "svelte/store";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

const TOAST_DURATION_MS = 3000;

let nextId = 0;

function createToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);

  function dismiss(id: number) {
    update((toasts) => toasts.filter((toast) => toast.id !== id));
  }

  function show(message: string, type: ToastType = "info") {
    const id = nextId++;
    update((toasts) => [...toasts, { id, message, type }]);
    setTimeout(() => dismiss(id), TOAST_DURATION_MS);
  }

  return { subscribe, show, dismiss };
}

export const toasts = createToastStore();

export function showToast(message: string, type: ToastType = "info") {
  toasts.show(message, type);
}
