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
  { href: "https://github.com/cyroz1/vidcord", label: "GitHub", external: true },
] as const;

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
