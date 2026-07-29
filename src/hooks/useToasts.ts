import { useState, useCallback, useEffect, useRef } from "react";
import { sendSystemNotification } from "../ipc";

export type ToastMsg = {
  id: number;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message: string;
  actions?: ToastAction[];
};

export type ToastAction = {
  label: string;
  onClick: () => void;
};

type ToastOptions = {
  actions?: ToastAction[];
  durationMs?: number | null;
  notifySystem?: boolean;
};

let toastId = 0;
let systemNotificationQueue = Promise.resolve();

type SystemNotificationSender = (title: string, body: string) => Promise<boolean>;

export function triggerSystemNotification(
  title: string,
  body: string,
  send: SystemNotificationSender = sendSystemNotification
): Promise<void> {
  // Preserve banner order when several outcomes are reported together. A
  // failed system delivery must not block later banners or create an
  // unhandled rejection; the in-app toast remains the reliable fallback.
  const delivery = systemNotificationQueue.then(async () => {
    try {
      await send(title, body);
    } catch {
      // The backend records platform delivery failures in the app log.
    }
  });
  systemNotificationQueue = delivery;
  return delivery;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  // Track auto-dismiss timers so we can cancel them on unmount or on manual
  // removal. Previously the setTimeout closure outlived the component and
  // fired a stale setToasts on unmounted trees when toasts were queued
  // rapidly; the per-id map also lets removeToast cancel a pending timer.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const addToast = useCallback(
    (type: ToastMsg["type"], title: string, message: string, options?: ToastOptions) => {
      const id = ++toastId;
      setToasts((t) => [...t, { id, type, title, message, actions: options?.actions }]);
      if (options?.notifySystem !== false) {
        void triggerSystemNotification(title, message);
      }

      const durationMs = options?.durationMs === undefined ? 5000 : options.durationMs;
      if (durationMs !== null) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id);
          setToasts((t) => t.filter((x) => x.id !== id));
        }, durationMs);
        timersRef.current.set(id, handle);
      }
    },
    []
  );

  const removeToast = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    },
    [clearTimer]
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  return { toasts, addToast, removeToast };
}
