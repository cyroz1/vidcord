import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type MutableRefObject,
} from "react";
import DesktopUpgrade from "./DesktopUpgrade";
import type { PageDropHandler, PendingPageDrop } from "./WebEditor";
import { getDonateLinks } from "../donate";
import FeedbackSection from "./FeedbackSection";
import "./WebApp.css";

const MARKETING_ASSET_BASE = import.meta.env.DEV ? "/site/marketing-assets" : "/marketing-assets";

function Logo() {
  return (
    <a className="web-logo" href="/" aria-label="vidcord home">
      <picture>
        <source
          type="image/webp"
          srcSet={`${MARKETING_ASSET_BASE}/icon-64.webp 64w, ${MARKETING_ASSET_BASE}/icon-128.webp 128w`}
          sizes="34px"
        />
        <img className="web-logo-mark" src="/icon.png" alt="" width={34} height={34} />
      </picture>
      <span>vidcord</span>
    </a>
  );
}

type SiteNavLink = {
  href: string;
  label: string;
  external?: boolean;
};

const SITE_NAV_LINKS: readonly SiteNavLink[] = [
  { href: "#desktop-app", label: "Desktop App" },
  { href: "#web-editor", label: "Web Demo" },
  { href: "#workflow", label: "How It Works" },
  { href: "#integrations", label: "Open With" },
  { href: "#faq", label: "FAQ" },
  { href: "#feedback", label: "Feedback" },
  { href: "#support", label: "Support" },
  { href: "https://github.com/cyroz1/vidcord", label: "GitHub", external: true },
] as const;

const PAGE_REVEAL_SELECTOR = [
  ".web-marketing > .hero > .hero-copy",
  ".web-marketing > .hero > .hero-product",
  ".web-marketing > #web-editor",
  ".web-marketing > .browser-section",
  ".web-marketing > .feature-band > article",
  ".web-marketing > .workflow-section > .section-heading",
  ".web-marketing > .workflow-section > .workflow-grid > article",
  ".web-marketing > .detail-section > .detail-copy",
  ".web-marketing > .detail-section > .detail-image",
  ".web-marketing > .integration-section > .section-heading",
  ".web-marketing > .integration-section > .integration-grid > .integration-panel",
  ".web-marketing > .faq-section > .section-heading",
  ".web-marketing > .faq-section > .faq-grid > article",
  ".web-marketing > .ffmpeg-section > .section-heading",
  ".web-marketing > .ffmpeg-section .ffmpeg-install-card",
  ".web-marketing > .download-section > .download-heading",
  ".web-marketing > .download-section > .ffmpeg-callout",
  ".web-marketing > .download-section .download-card",
  ".web-app > .donate-section",
  ".web-app > .feedback-section",
  ".web-app > .site-footer",
].join(", ");

function closeMobileNavigation(event: MouseEvent<HTMLAnchorElement>) {
  const disclosure = event.currentTarget.closest("details");
  if (disclosure) disclosure.open = false;
}

function SiteNavigation({ className }: { className: string }) {
  return (
    <nav className={className} aria-label="Site navigation">
      {SITE_NAV_LINKS.map((link) => (
        <a
          key={link.href}
          href={link.href}
          rel={link.external ? "noreferrer" : undefined}
          target={link.external ? "_blank" : undefined}
          onClick={closeMobileNavigation}
        >
          {link.label}
          {link.external && (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M7 17 17 7m0 0H9m8 0v8" />
            </svg>
          )}
        </a>
      ))}
    </nav>
  );
}

const LazyWebEditor = lazy(() => import("./WebEditor"));
const WEB_EDITOR_ROOT_MARGIN = "400px 0px";

type WebEditorLoaderProps = {
  dropHandlerRef: MutableRefObject<PageDropHandler | null>;
};

function WebEditorLoader({ dropHandlerRef }: WebEditorLoaderProps) {
  const [editorRequested, setEditorRequested] = useState(
    () => window.location.hash === "#web-editor"
  );
  const [pendingDrop, setPendingDrop] = useState<PendingPageDrop | null>(null);
  const editorSlotRef = useRef<HTMLDivElement>(null);
  const editorDropHandlerRef = useRef<PageDropHandler | null>(null);
  const nextDropIdRef = useRef(0);

  const handlePageDrop = useCallback((files: readonly File[]) => {
    if (editorDropHandlerRef.current) {
      editorDropHandlerRef.current(files);
      return;
    }

    if (files.length === 0) return;
    const id = ++nextDropIdRef.current;
    setPendingDrop({ id, files: [...files] });
    setEditorRequested(true);
  }, []);

  const handlePendingDropHandled = useCallback((dropId: number) => {
    setPendingDrop((current) => (current?.id === dropId ? null : current));
  }, []);

  useLayoutEffect(() => {
    dropHandlerRef.current = handlePageDrop;
    return () => {
      if (dropHandlerRef.current === handlePageDrop) {
        dropHandlerRef.current = null;
      }
    };
  }, [dropHandlerRef, handlePageDrop]);

  useEffect(() => {
    const loadForEditorAnchor = () => {
      if (window.location.hash === "#web-editor") setEditorRequested(true);
    };

    window.addEventListener("hashchange", loadForEditorAnchor);
    return () => window.removeEventListener("hashchange", loadForEditorAnchor);
  }, []);

  useEffect(() => {
    if (editorRequested) return;
    const target = editorSlotRef.current;

    if (!target || typeof IntersectionObserver === "undefined") {
      setEditorRequested(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEditorRequested(true);
          observer.disconnect();
        }
      },
      { rootMargin: WEB_EDITOR_ROOT_MARGIN }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [editorRequested]);

  return (
    <div ref={editorSlotRef} className="web-editor-slot" id="web-editor">
      {editorRequested ? (
        <Suspense
          fallback={
            <div className="web-editor-loading" role="status">
              Loading browser editor…
            </div>
          }
        >
          <LazyWebEditor
            dropHandlerRef={editorDropHandlerRef}
            pendingDrop={pendingDrop}
            onPendingDropHandled={handlePendingDropHandled}
          />
        </Suspense>
      ) : (
        <div className="web-editor-loading">
          The browser editor loads as you reach this section.
        </div>
      )}
    </div>
  );
}

function WebApp() {
  const dropHandlerRef = useRef<PageDropHandler | null>(null);
  const handlePageDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dropHandlerRef.current?.(Array.from(event.dataTransfer.files));
  }, []);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".web-app");
    if (
      !root ||
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    const targets = Array.from(root.querySelectorAll<HTMLElement>(PAGE_REVEAL_SELECTOR));
    if (targets.length === 0) return;

    targets.forEach((target) => {
      target.dataset.scrollReveal = "true";
    });

    const siblingsByParent = new Map<HTMLElement, HTMLElement[]>();
    targets.forEach((target) => {
      const parent = target.parentElement;
      if (!parent) return;
      const siblings = siblingsByParent.get(parent) ?? [];
      siblings.push(target);
      siblingsByParent.set(parent, siblings);
    });

    siblingsByParent.forEach((siblings) => {
      siblings.forEach((target, index) => {
        target.style.setProperty("--scroll-reveal-delay", `${Math.min(index * 85, 255)}ms`);
      });
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const target = entry.target as HTMLElement;
          target.dataset.scrollRevealed = "true";
          observer.unobserve(target);
        });
      },
      { rootMargin: "0px 0px -7% 0px", threshold: 0.08 }
    );

    targets.forEach((target) => observer.observe(target));
    root.dataset.motionReady = "true";

    return () => {
      observer.disconnect();
      delete root.dataset.motionReady;
      targets.forEach((target) => {
        delete target.dataset.scrollReveal;
        delete target.dataset.scrollRevealed;
        target.style.removeProperty("--scroll-reveal-delay");
      });
    };
  }, []);

  return (
    <div className="web-app" onDragOver={(event) => event.preventDefault()} onDrop={handlePageDrop}>
      <header className="web-header">
        <Logo />
        <SiteNavigation className="web-header-nav" />
        <details className="web-mobile-navigation">
          <summary className="web-mobile-menu-button" aria-label="Open navigation">
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </summary>
          <SiteNavigation className="web-mobile-nav" />
        </details>
      </header>

      <main className="web-main">
        <DesktopUpgrade>
          <WebEditorLoader dropHandlerRef={dropHandlerRef} />
        </DesktopUpgrade>
      </main>

      <section className="donate-section" id="support" aria-labelledby="donate-title">
        <div>
          <h2 id="donate-title">Support vidcord</h2>
          <p>
            vidcord is free and open source. If it saves you time, consider sponsoring development.
          </p>
        </div>
        <div className="donate-actions">
          {getDonateLinks().map((link) => (
            <a
              key={link.label}
              className="button button-secondary"
              href={link.url}
              target="_blank"
              rel="noreferrer"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 14C4 10.5 2 8 2 5.8 2 3.8 3.6 2.4 5.4 2.4c1.2 0 2.2.7 2.6 1.8.4-1.1 1.4-1.8 2.6-1.8 1.8 0 3.4 1.4 3.4 3.4 0 2.2-2 4.7-6 8.2Z" />
              </svg>
              <span>{link.label}</span>
            </a>
          ))}
        </div>
      </section>

      <FeedbackSection />

      <footer className="site-footer">
        <div>
          <a className="footer-brand" href="#desktop-app">
            <picture>
              <source
                type="image/webp"
                srcSet={`${MARKETING_ASSET_BASE}/icon-64.webp 64w, ${MARKETING_ASSET_BASE}/icon-128.webp 128w`}
                sizes="34px"
              />
              <img src={`${MARKETING_ASSET_BASE}/icon.png`} width="128" height="128" alt="" />
            </picture>
            <span>vidcord</span>
          </a>
          <p>Local video compression for Discord upload limits.</p>
        </div>
        <nav aria-label="Footer navigation">
          <a href="https://github.com/cyroz1/vidcord" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href="https://github.com/cyroz1/vidcord/issues" target="_blank" rel="noreferrer">
            Issues
          </a>
          <a
            href="https://github.com/cyroz1/vidcord/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            MIT License
          </a>
          <a href="/sitemap.xml">Sitemap</a>
          <a href="/llms.txt">AI context</a>
        </nav>
      </footer>
    </div>
  );
}

export default WebApp;
