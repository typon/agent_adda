import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  BookOpenText,
  Bot,
  ClipboardList,
  MessageSquare,
  Search,
  Settings,
  X,
} from "lucide-react";
import { OnboardingModal } from "@/components/onboarding/OnboardingModal";
import { getOnboardingStatus } from "@/lib/api/onboarding";
import type { ToolbarAction } from "./types";

type WindowChromeProps = {
  title: string;
  toolbar: ToolbarAction[];
  children: ReactNode;
  statusItems?: ReactNode;
  onOnboardingInitialized?: () => void;
};

const onboardingDismissedKey = "aa:onboarding-dismissed";

export function WindowChrome({
  title,
  toolbar,
  children,
  statusItems,
  onOnboardingInitialized
}: WindowChromeProps) {
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingIncomplete, setOnboardingIncomplete] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("/");
  const onboardingIncompleteRef = useRef(false);

  const setIncomplete = useCallback((incomplete: boolean) => {
    onboardingIncompleteRef.current = incomplete;
    setOnboardingIncomplete(incomplete);
  }, []);

  const openOnboarding = useCallback((updateHash: boolean) => {
    clearOnboardingDismissed();
    setOnboardingOpen(true);
    if (updateHash && typeof window !== "undefined") {
      window.location.hash = "#onboarding";
    }
  }, []);

  const handleOnboardingOpenChange = useCallback((open: boolean) => {
    setOnboardingOpen(open);
    if (!open && onboardingIncompleteRef.current) {
      rememberOnboardingDismissed();
    }
  }, []);

  const handleOnboardingInitialized = useCallback(() => {
    clearOnboardingDismissed();
    setIncomplete(false);
    onOnboardingInitialized?.();
  }, [onOnboardingInitialized, setIncomplete]);

  useEffect(() => {
    const controller = new AbortController();

    getOnboardingStatus(controller.signal)
      .then((status) => {
        if (controller.signal.aborted) {
          return;
        }

        const incomplete = !status.initialized;
        setIncomplete(incomplete);
        if (incomplete && !onboardingWasDismissed()) {
          setOnboardingOpen(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setIncomplete(false);
        }
      });

    return () => controller.abort();
  }, [setIncomplete]);

  useEffect(() => {
    function handleOpenOnboarding() {
      openOnboarding(false);
    }

    function handleHashChange() {
      if (window.location.hash === "#onboarding") {
        openOnboarding(false);
      }
    }

    window.addEventListener("aa:onboarding-open", handleOpenOnboarding);
    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();

    return () => {
      window.removeEventListener("aa:onboarding-open", handleOpenOnboarding);
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, [openOnboarding]);

  useEffect(() => {
    function syncPath() {
      setCurrentPath(window.location.pathname || "/");
    }

    syncPath();
    window.addEventListener("popstate", syncPath);
    window.addEventListener("hashchange", syncPath);
    return () => {
      window.removeEventListener("popstate", syncPath);
      window.removeEventListener("hashchange", syncPath);
    };
  }, []);

  useEffect(() => {
    if (!mobileMoreOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileMoreOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileMoreOpen]);

  return (
    <main className="h-[100dvh] overflow-hidden bg-[#008080] p-1 text-[12px] text-black md:h-auto md:min-h-[100dvh] md:overflow-auto md:p-2 md:text-[15px]">
      <section className="win-window flex h-full min-h-0 flex-col overflow-hidden md:min-h-[calc(100dvh-16px)] lg:h-[calc(100vh-16px)] lg:min-h-[680px]">
        <header className="win-titlebar shrink-0 justify-between px-2 py-1 md:px-2 md:py-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-4 w-4 shrink-0 place-items-center border border-white bg-cyan-500 text-[9px] text-black md:h-5 md:w-5 md:text-[10px]">
              AA
            </div>
            <h1 className="min-w-0 truncate text-[13px] leading-none md:text-lg">{title}</h1>
          </div>
        </header>

        {onboardingIncomplete && !onboardingOpen ? (
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-[#777] bg-[#fff4a3] px-3 py-2 text-sm">
            <AlertTriangle className="shrink-0 text-[var(--adda-danger)]" size={18} />
            <span className="min-w-0 flex-1 break-words">
              Setup is incomplete. Agent Adda is not useful until the onboarding wizard creates the workspace, agents, and first CEO tasks.
            </span>
            <button
              className="win-button flex min-h-8 shrink-0 items-center gap-2 px-3 py-0 max-sm:w-full max-sm:justify-center"
              onClick={() => openOnboarding(true)}
              type="button"
            >
              <ClipboardList size={16} />
              <span>Run setup wizard</span>
            </button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>

        <AppTaskbar
          currentPath={currentPath}
          moreOpen={mobileMoreOpen}
          onMoreOpenChange={setMobileMoreOpen}
          statusItems={statusItems}
          toolbar={toolbar}
        />
      </section>
      <OnboardingModal
        onInitialized={handleOnboardingInitialized}
        onOpenChange={handleOnboardingOpenChange}
        open={onboardingOpen}
      />
    </main>
  );
}

function AppTaskbar({
  currentPath,
  moreOpen,
  onMoreOpenChange,
  statusItems,
  toolbar,
}: {
  currentPath: string;
  moreOpen: boolean;
  onMoreOpenChange: (open: boolean) => void;
  statusItems?: ReactNode;
  toolbar: ToolbarAction[];
}) {
  const tabs = [
    { label: "Chats", href: "/#chats", path: "/", icon: MessageSquare },
    { label: "Wiki", href: "/wiki", path: "/wiki", icon: BookOpenText },
    { label: "Stats", href: "/stats", path: "/stats", icon: BarChart3 },
  ];
  const pageActions = toolbar.filter((action) => !routeActionLabels.has(action.label) && !globalActionLabels.has(action.label));
  const pageActionSlots = fixedPageActionSlots.map((_, index) => pageActions[index] ?? null);

  return (
    <>
      <nav aria-label="Application taskbar" className="aa-taskbar">
        <button
          aria-expanded={moreOpen}
          aria-label="Open more actions"
          className={`aa-taskbar-start ${moreOpen ? "is-active" : ""}`}
          data-aa-taskbar-start
          onClick={() => onMoreOpenChange(!moreOpen)}
          type="button"
        >
          <span className="aa-taskbar-start-logo">AA</span>
          <span>Start</span>
        </button>
        <div className="aa-taskbar-global-actions" data-aa-taskbar-global-actions>
          <TaskbarAction action={{ label: "Global Search", icon: Search }} />
          <TaskbarAction action={{ label: "Settings", icon: Settings }} />
        </div>
        <div className="aa-taskbar-tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const active = currentPath === tab.path || (tab.path === "/" && currentPath === "");
            return (
              <a
                aria-current={active ? "page" : undefined}
                className={`aa-taskbar-button ${active ? "is-active" : ""}`}
                data-aa-taskbar-tab={tab.label.toLowerCase()}
                href={tab.href}
                key={tab.label}
              >
                <Icon size={14} />
                <span>{tab.label}</span>
              </a>
            );
          })}
        </div>
        <div aria-label="Page actions" className="aa-taskbar-page-actions" data-aa-taskbar-page-actions>
          {pageActionSlots.map((action, index) =>
            action ? (
              <TaskbarAction action={action} key={`${action.label}-${index}`} />
            ) : (
              <span aria-hidden className="aa-taskbar-action-spacer" data-aa-taskbar-action-slot key={`empty-${index}`} />
            )
          )}
        </div>
        <div aria-label="Status" className="aa-taskbar-status">
          {statusItems ?? (
            <>
              <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">Ready</div>
              <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">Agent Adda</div>
            </>
          )}
        </div>
      </nav>
      {moreOpen ? (
        <div className="aa-taskbar-sheet-backdrop" role="presentation" onClick={() => onMoreOpenChange(false)}>
          <section
            aria-label="More actions"
            className="aa-taskbar-sheet"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="win-titlebar justify-between">
              <span>More</span>
              <button
                aria-label="Close more actions"
                className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
                onClick={() => onMoreOpenChange(false)}
                type="button"
              >
                <X size={13} />
              </button>
            </div>
            <div className="grid gap-1 p-2">
              {pageActions.length > 0 ? (
                <div className="grid gap-1 border-b border-[#777] pb-2">
                  {pageActions.map((action, index) => (
                    <MoreToolbarAction
                      action={action}
                      key={`${action.label}-${index}`}
                      onComplete={() => onMoreOpenChange(false)}
                    />
                  ))}
                </div>
              ) : null}
              <MoreAction icon={<Search size={16} />} label="Global Search" onClick={() => {
                onMoreOpenChange(false);
                handleToolbarAction("Global Search");
              }} />
              <MoreAction icon={<Settings size={16} />} label="Settings" onClick={() => {
                onMoreOpenChange(false);
                handleToolbarAction("Settings");
              }} />
              <MoreLink href="/ops" icon={<Bot size={16} />} label="Ops Desk" />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

const routeActionLabels = new Set(["Stats", "Wiki Mode", "Agent Mode"]);
const globalActionLabels = new Set(["Global Search", "Settings"]);
const fixedPageActionSlots = [0, 1, 2] as const;

function TaskbarAction({ action }: { action: ToolbarAction }) {
  const Icon = action.icon;
  const label = taskbarActionLabel(action.label);
  const className = `aa-taskbar-button aa-taskbar-action ${action.pressed ? "is-active" : ""}`;

  if (action.href) {
    return (
      <a
        aria-disabled={action.disabled || undefined}
        aria-label={action.label}
        className={className}
        href={action.disabled ? undefined : action.href}
        role="button"
      >
        <Icon size={14} />
        <span>{label}</span>
      </a>
    );
  }

  return (
    <button
      aria-label={action.label}
      aria-pressed={action.pressed ?? undefined}
      className={className}
      data-aa-open-settings={action.label === "Settings" ? true : undefined}
      disabled={action.disabled}
      onClick={() => {
        if (action.onClick) {
          action.onClick();
          return;
        }
        handleToolbarAction(action.label);
      }}
      type="button"
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}

function taskbarActionLabel(label: string): string {
  if (label === "Global Search") return "Search";
  return label;
}

function MoreAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="win-button flex min-h-9 items-center justify-start gap-2 px-3 py-1 text-left"
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MoreToolbarAction({
  action,
  onComplete,
}: {
  action: ToolbarAction;
  onComplete: () => void;
}) {
  const Icon = action.icon;
  const className = "win-button flex min-h-9 items-center justify-start gap-2 px-3 py-1 text-left no-underline";

  if (action.href) {
    return (
      <a
        aria-disabled={action.disabled || undefined}
        className={className}
        href={action.disabled ? undefined : action.href}
      >
        <Icon size={16} />
        <span>{action.label}</span>
      </a>
    );
  }

  return (
    <button
      aria-pressed={action.pressed ?? undefined}
      className={className}
      disabled={action.disabled}
      onClick={() => {
        action.onClick?.();
        onComplete();
      }}
      type="button"
    >
      <Icon size={16} />
      <span>{action.label}</span>
    </button>
  );
}

function MoreLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a className="win-button flex min-h-9 items-center justify-start gap-2 px-3 py-1 text-left no-underline" href={href}>
      {icon}
      <span>{label}</span>
    </a>
  );
}

function onboardingWasDismissed(): boolean {
  return typeof window !== "undefined" && window.sessionStorage.getItem(onboardingDismissedKey) === "true";
}

function rememberOnboardingDismissed() {
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(onboardingDismissedKey, "true");
  }
}

function clearOnboardingDismissed() {
  if (typeof window !== "undefined") {
    window.sessionStorage.removeItem(onboardingDismissedKey);
  }
}

function handleToolbarAction(label: string) {
  if (typeof window === "undefined") {
    return;
  }

  switch (label) {
    case "Settings":
      window.dispatchEvent(new CustomEvent("aa:settings-open"));
      window.location.hash = "#settings";
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("aa:settings-open")), 0);
      break;
    case "Global Search":
      window.dispatchEvent(new CustomEvent("aa:global-search-open"));
      break;
    case "Stats":
      window.location.href = "/stats";
      break;
    case "Wiki Mode":
      window.location.href = "/wiki";
      break;
    case "Agent Mode":
      window.location.href = "/";
      break;
    default:
      break;
  }
}
