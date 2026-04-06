import { useState, useCallback } from "react";

export type ToastMsg = {
  id: number;
  type: "success" | "error" | "warning" | "info";
  title: string;
  message: string;
};

let toastId = 0;

export function useToasts() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);

  const addToast = useCallback((type: ToastMsg["type"], title: string, message: string) => {
    const id = ++toastId;
    setToasts((t) => [...t, { id, type, title, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  return { toasts, addToast, removeToast };
}
