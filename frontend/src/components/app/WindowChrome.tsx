import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ClipboardList } from "lucide-react";
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

  return (
    <main className="min-h-[100dvh] bg-[#008080] p-1.5 text-[14px] text-black sm:p-2 sm:text-[15px]">
      <section className="win-window flex min-h-[calc(100dvh-12px)] flex-col overflow-hidden lg:h-[calc(100vh-16px)] lg:min-h-[680px]">
        <header className="win-titlebar shrink-0 justify-between px-3 py-2 sm:px-2 sm:py-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="grid h-5 w-5 shrink-0 place-items-center border border-white bg-cyan-500 text-[10px] text-black">
              AA
            </div>
            <h1 className="min-w-0 truncate text-base leading-none sm:text-lg">{title}</h1>
          </div>
        </header>

        {toolbar.length > 0 ? (
          <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-[#777] bg-[#d0d0d0] p-2 sm:flex sm:min-h-[82px] sm:items-stretch sm:gap-1 sm:overflow-x-auto">
            {toolbar.map((action) => {
              const Icon = action.icon;
              const iconOnly = action.label === "Settings";
              const className = `win-button flex min-h-[60px] flex-col items-center justify-center gap-1 px-3 text-sm disabled:cursor-not-allowed disabled:text-[#777] sm:min-h-[70px] sm:text-base ${
                iconOnly ? "sm:min-w-14" : "sm:min-w-[112px]"
              } ${action.alignEnd ? "sm:ml-auto" : ""}`;
              if (action.href) {
                return (
                  <a
                    aria-disabled={action.disabled || undefined}
                    className={className}
                    href={action.disabled ? undefined : action.href}
                    key={action.label}
                    role="button"
                  >
                    <Icon size={22} strokeWidth={2.2} />
                    {iconOnly ? <span className="text-center leading-tight sm:hidden">{action.label}</span> : <span className="text-center leading-tight">{action.label}</span>}
                  </a>
                );
              }
              return (
                <button
                  aria-label={iconOnly ? action.label : undefined}
                  className={className}
                  data-aa-open-settings={action.label === "Settings" ? true : undefined}
                  disabled={action.disabled}
                  key={action.label}
                  onClick={() => {
                    if (action.onClick) {
                      action.onClick();
                      return;
                    }
                    handleToolbarAction(action.label);
                  }}
                  aria-pressed={action.pressed ?? undefined}
                  type="button"
                >
                  <Icon size={22} strokeWidth={2.2} />
                  {iconOnly ? <span className="text-center leading-tight sm:hidden">{action.label}</span> : <span className="text-center leading-tight">{action.label}</span>}
                </button>
              );
            })}
          </div>
        ) : null}

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

        <footer className="aa-statusbar shrink-0 border-t-2 border-t-[#777] bg-[#cfcfcf] p-1">
          {statusItems ?? (
            <>
              <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">Ready</div>
              <div className="win-panel flex min-w-0 items-center gap-2 truncate px-3">Agent Adda</div>
              <div className="win-panel aa-statusbar-ins flex min-w-0 items-center truncate">INS</div>
            </>
          )}
        </footer>
      </section>
      <OnboardingModal
        onInitialized={handleOnboardingInitialized}
        onOpenChange={handleOnboardingOpenChange}
        open={onboardingOpen}
      />
    </main>
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
