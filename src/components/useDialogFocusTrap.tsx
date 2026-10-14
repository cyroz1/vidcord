import { useEffect, type CSSProperties, type RefObject } from "react";

export const DIALOG_FOCUSABLE_SELECTOR =
  "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
  "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export const dialogBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.44)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};

export const dialogTitleBarStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexShrink: 0,
};

export const dialogTitleStyle: CSSProperties = {
  margin: 0,
  fontWeight: 600,
  fontSize: "14px",
  color: "var(--text)",
};

export const dialogTitleCloseStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--text-secondary)",
  fontSize: "13px",
  cursor: "pointer",
  padding: "2px 6px",
  borderRadius: "var(--radius-xs)",
  lineHeight: 1,
};

/**
 * Shared modal scaffolding for the app's dialogs: initial focus on open,
 * a Tab focus trap, Escape routed through `requestClose`, and focus
 * restoration to the previously focused element on close.
 */
export function useDialogFocusTrap<E extends HTMLElement>(
  dialogRef: RefObject<HTMLDivElement | null>,
  initialFocusRef: RefObject<E | null>,
  requestClose: () => void
): void {
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusFrame = window.requestAnimationFrame(() => {
      (initialFocusRef.current ?? dialogRef.current)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)
      ).filter((element) => element.getClientRects().length > 0);

      event.preventDefault();
      event.stopPropagation();
      if (focusable.length === 0) {
        dialog.focus();
        return;
      }

      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? activeIndex <= 0
          ? focusable.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      focusable[nextIndex].focus();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);

      if (previousFocus?.isConnected) {
        window.requestAnimationFrame(() => previousFocus.focus());
      }
    };
  }, [dialogRef, initialFocusRef, requestClose]);
}
