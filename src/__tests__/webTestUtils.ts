import { vi } from "vitest";

export function mockIntersectionObserverAsVisible(): void {
  class VisibleIntersectionObserver implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin: string;
    readonly thresholds: ReadonlyArray<number>;

    constructor(
      private readonly callback: IntersectionObserverCallback,
      options?: IntersectionObserverInit
    ) {
      this.root = options?.root ?? null;
      this.rootMargin = options?.rootMargin ?? "0px";
      const threshold = options?.threshold ?? 0;
      this.thresholds = typeof threshold === "number" ? [threshold] : threshold;
    }

    observe(target: Element): void {
      const bounds = target.getBoundingClientRect();
      this.callback(
        [
          {
            boundingClientRect: bounds,
            intersectionRatio: 1,
            intersectionRect: bounds,
            isIntersecting: true,
            rootBounds: null,
            target,
            time: 0,
          },
        ],
        this
      );
    }

    unobserve(): void {}

    disconnect(): void {}

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
}
