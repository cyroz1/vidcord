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

const MAX_TOASTS = 5;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  // Track auto-dismiss timers so we can cancel them on unmount or on manual
  // removal. Previously the setTimeout closure outlived the component and
  // fired a stale setToasts on unmounted trees when toasts were queued
  // rapidly; the per-id map also lets removeToast cancel a pending timer.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // Mirror of the queue plus the persistent (never-expiring) ids so addToast
  // can enforce the queue cap synchronously and drop the oldest
  // non-persistent toast first, cancelling its timer as it goes.
  const toastsRef = useRef<ToastMsg[]>([]);
  const persistentIdsRef = useRef<Set<number>>(new Set());

  const clearTimer = useCallback((id: number) => {
    const t = timersRef.current.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timersRef.current.delete(id);
    }
  }, []);

  const applyToasts = useCallback((next: ToastMsg[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const addToast = useCallback(
    (type: ToastMsg["type"], title: string, message: string, options?: ToastOptions) => {
      const id = ++toastId;
      const durationMs = options?.durationMs === undefined ? 5000 : options.durationMs;
      if (durationMs === null) persistentIdsRef.current.add(id);

      let next = [...toastsRef.current, { id, type, title, message, actions: options?.actions }];
      let newcomerDropped = false;
      while (next.length > MAX_TOASTS) {
        // Prefer dropping the oldest non-persistent toast. A persistent
        // toast (e.g. the lossless offer, which carries action buttons)
        // must never be evicted for a non-persistent newcomer: when every
        // retained toast is persistent, the only non-persistent candidate
        // is the newcomer itself, so it is the one dropped.
        const dropIndex = next.findIndex((toast) => !persistentIdsRef.current.has(toast.id));
        const dropped =
          next[
            dropIndex === -1
              ? // All retained toasts and the newcomer are persistent; fall
                // back to dropping the oldest to keep the cap.
                0
              : dropIndex
          ];
        clearTimer(dropped.id);
        persistentIdsRef.current.delete(dropped.id);
        if (dropped.id === id) newcomerDropped = true;
        next = next.filter((toast) => toast.id !== dropped.id);
      }
      if (newcomerDropped) {
        // The newcomer never became a toast, so it must not mirror to a
        // system notification either: system notifications mirror in-app
        // toasts, and there is no in-app toast for this one. Drop silently
        // (no notification, no timer) and leave the queue untouched.
        return;
      }
      applyToasts(next);

      if (options?.notifySystem !== false) {
        void triggerSystemNotification(title, message);
      }

      if (durationMs !== null) {
        const handle = setTimeout(() => {
          timersRef.current.delete(id);
          persistentIdsRef.current.delete(id);
          applyToasts(toastsRef.current.filter((x) => x.id !== id));
        }, durationMs);
        timersRef.current.set(id, handle);
      }
    },
    [applyToasts, clearTimer]
  );

  const removeToast = useCallback(
    (id: number) => {
      clearTimer(id);
      persistentIdsRef.current.delete(id);
      applyToasts(toastsRef.current.filter((x) => x.id !== id));
    },
    [applyToasts, clearTimer]
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
