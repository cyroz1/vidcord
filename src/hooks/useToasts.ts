import { useState, useCallback, useEffect, useRef } from "react";

export type ToastMsg = {
  id: number;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message: string;
};

let toastId = 0;

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

  const addToast = useCallback((type: ToastMsg["type"], title: string, message: string) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, type, title, message }]);
    const handle = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
    timersRef.current.set(id, handle);
  }, []);

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
