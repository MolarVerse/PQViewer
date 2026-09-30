import { useEffect } from "react";

export type FocusTarget = Element & { focus: (options?: FocusOptions) => void };

export function useModalFocus<T extends HTMLElement>(
  panelRef: Readonly<{ current: T | null }>,
  initialRef?: Readonly<{ current: HTMLElement | null }>,
) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modalRoot = panel.parentElement;
    const background = modalRoot?.parentElement
      ? [...modalRoot.parentElement.children]
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== modalRoot)
        .map((element) => ({ element, inert: element.inert }))
      : [];
    background.forEach(({ element }) => { element.inert = true; });

    const focusable = () => [...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.offsetParent !== null);
    const focusInitial = () => (initialRef?.current ?? focusable()[0] ?? panel).focus();
    const animation = requestAnimationFrame(focusInitial);
    const keepFocusInside = (event: FocusEvent) => {
      if (!panel.contains(event.target as Node)) focusInitial();
    };
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("focusin", keepFocusInside);
    panel.addEventListener("keydown", trapTab);
    return () => {
      cancelAnimationFrame(animation);
      document.removeEventListener("focusin", keepFocusInside);
      panel.removeEventListener("keydown", trapTab);
      background.forEach(({ element, inert }) => { element.inert = inert; });
      restoreFocusWhenAvailable(restoreFocus);
    };
  }, []);
}

export function usePanelFocusRestore<T extends HTMLElement>(
  panelRef: Readonly<{ current: T | null }>,
  fallbackRef: Readonly<{ current: HTMLElement | null }>,
) {
  useEffect(() => {
    const panel = panelRef.current;
    const origin = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body
      ? document.activeElement
      : null;
    if (!panel) return;
    return () => {
      const active = document.activeElement;
      if (
        active === document.body
        || active === null
        || panel.contains(active)
      ) {
        restoreFocusWhenAvailable(
          origin?.isConnected ? origin : fallbackRef.current,
        );
      }
    };
  }, [fallbackRef]);
}

export function restoreFocusWhenAvailable(element: FocusTarget | null) {
  if (!element?.isConnected) return;
  if (!element.matches(":disabled")) {
    element.focus();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!element.isConnected || element.matches(":disabled")) return;
    window.clearTimeout(timeout);
    observer.disconnect();
    element.focus();
  });
  const timeout = window.setTimeout(() => observer.disconnect(), 30_000);
  observer.observe(element, { attributes: true, attributeFilter: ["disabled"] });
}
