import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Plus,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";
import {
  knownReasoningEfforts,
  loadCodexReasoningEfforts,
  normalizeReasoningEffort,
  type ReasoningEffort
} from "@/lib/api/codex";
import {
  initializeOnboarding,
  loadOnboardingDefaults,
  settingValue,
  type OnboardingCheck,
  type OnboardingStatusResponse,
  type StarterRoleDraft
} from "@/lib/api/onboarding";

type OnboardingModalProps = {
  open: boolean;
  onInitialized?: () => void;
  onOpenChange: (open: boolean) => void;
};

type LoadState = "loading" | "ready" | "error";
type SubmitState = "idle" | "submitting" | "success" | "error";

type OnboardingDraft = {
  projectName: string;
  projectSummary: string;
  workspacePath: string;
  defaultModel: string;
  reasoningEffort: ReasoningEffort;
  extraRoles: StarterRoleDraft[];
  majorTasks: string[];
};

const modelOptions = ["gpt-5.5", "gpt-5.5-mini", "gpt-5-codex", "gpt-5.1"];

const defaultProjectSummary = "";

const defaultExtraRoles: StarterRoleDraft[] = [
  {
    name: "Frontend Steward",
    role: "UI implementation",
    description: "Owns interactive screens, visual polish, and narrow frontend checks."
  },
  {
    name: "Validation Runner",
    role: "Quality checks",
    description: "Runs targeted checks, records failures, and verifies fixes before handoff."
  }
];

const defaultMajorTasks = [
  "Confirm Codex, GitHub, and workspace checks.",
  "Populate the wiki with project-specific operating notes.",
  "Create first useful mission-control rooms and starter employees.",
  "Keep PR handoff and review loops visible in the workspace."
];

const blankRole: StarterRoleDraft = {
  name: "",
  role: "",
  description: ""
};

export function OnboardingModal({
  open,
  onInitialized,
  onOpenChange
}: OnboardingModalProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => makeDefaultDraft());
  const [checks, setChecks] = useState<OnboardingCheck[]>([]);
  const [reasoningOptions, setReasoningOptions] = useState<ReasoningEffort[]>(() => [
    ...knownReasoningEfforts
  ]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [statusText, setStatusText] = useState("Loading onboarding defaults...");
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");

    loadOnboardingDefaults(controller.signal)
      .then((defaults) => {
        setDraft((current) => draftWithDefaults(current, defaults.settings, defaults.status));
        setChecks(defaults.checks);
        setLoadState("ready");
        setStatusText(defaults.checks.length > 0 ? "Defaults loaded." : "Defaults loaded; checks pending.");
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }

        setLoadState("error");
        setStatusText("Settings API unavailable. Fallback defaults are shown.");
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const model = draft.defaultModel;

    loadCodexReasoningEfforts(model, controller.signal)
      .then((efforts) => {
        setReasoningOptions(efforts);
        setDraft((current) => {
          if (current.defaultModel !== model) {
            return current;
          }
          return {
            ...current,
            reasoningEffort: normalizeReasoningEffort(current.reasoningEffort, efforts)
          };
        });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          return;
        }
      });

    return () => controller.abort();
  }, [draft.defaultModel]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const previousFocus = document.activeElement;
    document.documentElement.classList.add("aa-onboarding-open");

    const focusTimer = window.setTimeout(() => {
      firstFieldRef.current?.focus();
    }, 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.documentElement.classList.remove("aa-onboarding-open");
      document.removeEventListener("keydown", handleKeyDown);

      if (previousFocus instanceof HTMLElement) {
        previousFocus.focus();
      }
    };
  }, [open]);

  function closeModal() {
    onOpenChange(false);
    if (typeof window !== "undefined" && window.location.hash === "#onboarding") {
      history.pushState(null, "", `${window.location.pathname}${window.location.search}`);
    }
  }

  function updateTextField(field: "projectName" | "projectSummary" | "workspacePath" | "defaultModel", value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    clearSubmitError();
  }

  function updateReasoningEffort(value: string) {
    setDraft((current) => ({
      ...current,
      reasoningEffort: normalizeReasoningEffort(value, reasoningOptions)
    }));
    clearSubmitError();
  }

  function updateRole(index: number, field: keyof StarterRoleDraft, value: string) {
    setDraft((current) => {
      const nextRoles = current.extraRoles.slice();
      nextRoles[index] = {
        ...nextRoles[index],
        [field]: value
      };
      return { ...current, extraRoles: nextRoles };
    });
    clearSubmitError();
  }

  function addRole() {
    setDraft((current) => {
      if (current.extraRoles.length >= 8) {
        return current;
      }
      return {
        ...current,
        extraRoles: [...current.extraRoles, { ...blankRole }]
      };
    });
  }

  function removeRole(index: number) {
    setDraft((current) => ({
      ...current,
      extraRoles: current.extraRoles.filter((_, roleIndex) => roleIndex !== index)
    }));
    clearSubmitError();
  }

  function updateTask(index: number, value: string) {
    setDraft((current) => {
      const nextTasks = current.majorTasks.slice();
      nextTasks[index] = value;
      return { ...current, majorTasks: nextTasks };
    });
    clearSubmitError();
  }

  function addTask() {
    setDraft((current) => {
      if (current.majorTasks.length >= 12) {
        return current;
      }
      return {
        ...current,
        majorTasks: [...current.majorTasks, ""]
      };
    });
  }

  function removeTask(index: number) {
    setDraft((current) => ({
      ...current,
      majorTasks: current.majorTasks.filter((_, taskIndex) => taskIndex !== index)
    }));
    clearSubmitError();
  }

  function clearSubmitError() {
    if (submitState === "error") {
      setSubmitState("idle");
      setStatusText(loadState === "error" ? "Fallback defaults are shown." : "Ready.");
    }
  }

  async function handleSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();

    const request = requestFromDraft(draft);
    if (typeof request === "string") {
      setSubmitState("error");
      setStatusText(request);
      return;
    }

    setSubmitState("submitting");
    setStatusText("Initializing workspace...");

    try {
      const response = await initializeOnboarding(request);
      setSubmitState("success");
      setStatusText(initializedMessage(response));
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("aa:project-name-updated", {
          detail: { projectName: response.status.project_name }
        }));
      }
      onInitialized?.();
      closeModal();
    } catch (error: unknown) {
      setSubmitState("error");
      setStatusText(initializationErrorText(error));
    }
  }

  if (!open) {
    return null;
  }

  const busy = submitState === "submitting";

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/35 p-3">
      <button
        aria-label="Close onboarding"
        className="absolute inset-0 cursor-default border-0 bg-transparent"
        disabled={busy}
        onClick={closeModal}
        type="button"
      />
      <section
        aria-labelledby="aa-onboarding-title"
        aria-modal="true"
        className="win-window relative flex max-h-[min(860px,92vh)] w-[min(980px,calc(100vw-24px))] flex-col overflow-hidden bg-[var(--adda-panel)]"
        role="dialog"
      >
        <header className="win-titlebar shrink-0 justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <ClipboardList className="shrink-0" size={20} />
            <h2 className="truncate text-base" id="aa-onboarding-title">First-Run Onboarding</h2>
          </div>
          <button
            aria-label="Close onboarding"
            className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
            disabled={busy}
            onClick={closeModal}
            type="button"
          >
            <X size={14} />
          </button>
        </header>

        <form className="app-scrollbar min-h-0 overflow-auto p-3" onSubmit={handleSubmit}>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="grid min-w-0 gap-3">
              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">Project Identity</legend>
                <label className="mb-1 block font-bold" htmlFor="aa-onboarding-project-name">Project name</label>
                <input
                  aria-label="Project name"
                  className="win-panel-inset mb-3 min-h-9 w-full min-w-0 bg-white px-2"
                  disabled={busy}
                  id="aa-onboarding-project-name"
                  onChange={(event) => updateTextField("projectName", event.target.value)}
                  ref={firstFieldRef}
                  value={draft.projectName}
                />
                <label className="mb-1 block font-bold" htmlFor="aa-onboarding-project-summary">Project summary</label>
                <textarea
                  aria-label="Project summary"
                  className="win-panel-inset min-h-28 w-full resize-y bg-white p-2"
                  disabled={busy}
                  id="aa-onboarding-project-summary"
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                    updateTextField("projectSummary", event.target.value);
                  }}
                  placeholder="What is this project or company building, and what should the agents focus on?"
                  value={draft.projectSummary}
                />
              </fieldset>

              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">Workspace Defaults</legend>
                <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
                  <label className="font-bold" htmlFor="aa-onboarding-workspace">Existing workspace path</label>
                  <input
                    className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                    disabled={busy}
                    id="aa-onboarding-workspace"
                    onChange={(event) => updateTextField("workspacePath", event.target.value)}
                    value={draft.workspacePath}
                  />

                  <label className="font-bold" htmlFor="aa-onboarding-model">Default model</label>
                  <select
                    className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                    disabled={busy}
                    id="aa-onboarding-model"
                    onChange={(event) => updateTextField("defaultModel", event.target.value)}
                    value={draft.defaultModel}
                  >
                    {modelOptions.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>

                  <label className="font-bold" htmlFor="aa-onboarding-reasoning">Reasoning effort</label>
                  <select
                    className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                    disabled={busy}
                    id="aa-onboarding-reasoning"
                    onChange={(event) => updateReasoningEffort(event.target.value)}
                    value={draft.reasoningEffort}
                  >
                    {reasoningOptions.map((effort) => (
                      <option key={effort} value={effort}>{effort}</option>
                    ))}
                  </select>
                </div>
              </fieldset>

              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">Extra Roles</legend>
                <div className="mb-2 flex justify-end">
                  <button
                    className="win-button flex min-h-8 items-center gap-1 px-2"
                    disabled={busy || draft.extraRoles.length >= 8}
                    onClick={addRole}
                    type="button"
                  >
                    <Plus size={16} />
                    <span>Add</span>
                  </button>
                </div>
                <div className="grid gap-2">
                  {draft.extraRoles.length === 0 ? (
                    <p className="win-panel-inset m-0 bg-white p-2 text-[var(--adda-muted)]">No extra roles selected.</p>
                  ) : null}
                  {draft.extraRoles.map((role, index) => (
                    <div className="win-panel-inset grid gap-2 bg-white p-2" key={index}>
                      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_34px]">
                        <input
                          aria-label={`Role ${index + 1} name`}
                          className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                          disabled={busy}
                          onChange={(event) => updateRole(index, "name", event.target.value)}
                          placeholder="Name"
                          value={role.name}
                        />
                        <input
                          aria-label={`Role ${index + 1} responsibility`}
                          className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                          disabled={busy}
                          onChange={(event) => updateRole(index, "role", event.target.value)}
                          placeholder="Role"
                          value={role.role}
                        />
                        <button
                          aria-label={`Remove role ${index + 1}`}
                          className="win-button grid h-9 min-h-0 w-[34px] place-items-center p-0"
                          disabled={busy}
                          onClick={() => removeRole(index)}
                          type="button"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <input
                        aria-label={`Role ${index + 1} description`}
                        className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                        disabled={busy}
                        onChange={(event) => updateRole(index, "description", event.target.value)}
                        placeholder="Description"
                        value={role.description}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>

              <fieldset className="win-panel bg-[#dfdfdf] p-3">
                <legend className="px-1 font-bold">Major Tasks</legend>
                <div className="mb-2 flex justify-end">
                  <button
                    className="win-button flex min-h-8 items-center gap-1 px-2"
                    disabled={busy || draft.majorTasks.length >= 12}
                    onClick={addTask}
                    type="button"
                  >
                    <Plus size={16} />
                    <span>Add</span>
                  </button>
                </div>
                <div className="grid gap-2">
                  {draft.majorTasks.map((task, index) => (
                    <div className="grid gap-2 sm:grid-cols-[28px_minmax(0,1fr)_34px]" key={index}>
                      <div className="win-panel grid h-9 place-items-center bg-[#e6e6e6] font-bold">{index + 1}</div>
                      <input
                        aria-label={`Major task ${index + 1}`}
                        className="win-panel-inset min-h-9 min-w-0 bg-white px-2"
                        disabled={busy}
                        onChange={(event) => updateTask(index, event.target.value)}
                        value={task}
                      />
                      <button
                        aria-label={`Remove task ${index + 1}`}
                        className="win-button grid h-9 min-h-0 w-[34px] place-items-center p-0"
                        disabled={busy}
                        onClick={() => removeTask(index)}
                        type="button"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </fieldset>
            </div>

            <aside className="grid min-w-0 content-start gap-3">
              <section className="win-panel bg-[#dfdfdf] p-3">
                <h3 className="mb-2 font-bold">Setup Status</h3>
                <StatusMessage loadState={loadState} submitState={submitState} text={statusText} />
              </section>

              <section className="win-panel bg-[#dfdfdf] p-3">
                <h3 className="mb-2 font-bold">Onboarding Checks</h3>
                {checks.length === 0 ? (
                  <div className="win-panel-inset bg-white p-2 text-[var(--adda-muted)]">No checks returned.</div>
                ) : (
                  <ul className="m-0 grid list-none gap-1 p-0">
                    {checks.map((check) => (
                      <li
                        className="win-panel-inset grid min-h-10 grid-cols-[14px_minmax(0,1fr)] gap-2 bg-white p-2"
                        key={check.check_key}
                      >
                        <span className={`status-dot mt-1 ${statusDotClass(check.status)}`} />
                        <span className="min-w-0">
                          <strong className="block truncate">{check.label}</strong>
                          <small className="block break-words text-[var(--adda-muted)]">
                            {check.detail || check.checked_at || "Pending"}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>

          <footer className="mt-3 flex flex-wrap justify-end gap-2 border-t border-[#777] pt-3">
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy} onClick={closeModal} type="button">
              <X size={16} />
              <span>Close</span>
            </button>
            <button className="win-button flex min-h-9 items-center gap-2" disabled={busy} type="submit">
              {busy ? <RefreshCw className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
              <span>{busy ? "Initializing" : "Initialize"}</span>
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function StatusMessage({
  loadState,
  submitState,
  text
}: {
  loadState: LoadState;
  submitState: SubmitState;
  text: string;
}) {
  const Icon = submitState === "success" ? CheckCircle2 : submitState === "error" || loadState === "error" ? AlertTriangle : ClipboardList;
  const colorClass =
    submitState === "success"
      ? "text-[var(--adda-success)]"
      : submitState === "error" || loadState === "error"
        ? "text-[var(--adda-danger)]"
        : "text-[var(--adda-info)]";

  return (
    <div className="win-panel-inset flex min-h-16 gap-2 bg-white p-2">
      <Icon className={`mt-1 shrink-0 ${colorClass}`} size={18} />
      <p className="m-0 min-w-0 break-words leading-snug">{text}</p>
    </div>
  );
}

function makeDefaultDraft(): OnboardingDraft {
  return {
    projectName: "",
    projectSummary: defaultProjectSummary,
    workspacePath: "",
    defaultModel: "gpt-5.5",
    reasoningEffort: "high",
    extraRoles: defaultExtraRoles.map((role) => ({ ...role })),
    majorTasks: defaultMajorTasks.slice()
  };
}

function draftWithDefaults(
  current: OnboardingDraft,
  settings: { key: string; value: string }[],
  status: OnboardingStatusResponse | null
): OnboardingDraft {
  const workspacePath = settingValue(
    settings,
    "workspace_path",
    current.workspacePath
  );
  const projectName =
    status?.project_name?.trim() || settingValue(settings, "project_name", current.projectName);
  const defaultModel = settingValue(settings, "default_model", current.defaultModel);
  const reasoningEffort = normalizeReasoningEffort(
    settingValue(settings, "default_reasoning_effort", current.reasoningEffort)
  );

  return {
    ...current,
    projectName,
    workspacePath: status?.workspace_path?.trim() || workspacePath,
    defaultModel,
    reasoningEffort
  };
}

function requestFromDraft(draft: OnboardingDraft) {
  const projectName = draft.projectName.trim();
  const projectSummary = draft.projectSummary.trim();
  const workspacePath = draft.workspacePath.trim();
  const defaultModel = draft.defaultModel.trim();
  const extraRoles = cleanedRoles(draft.extraRoles);
  const majorTasks = cleanedTasks(draft.majorTasks);

  if (!projectName) {
    return "Project name is required.";
  }
  if (!projectSummary) {
    return "Project summary is required.";
  }
  if (!workspacePath) {
    return "Existing workspace path is required.";
  }
  if (!defaultModel) {
    return "Default model is required.";
  }
  if (hasIncompleteRole(draft.extraRoles)) {
    return "Each extra role needs a name and role, or the row should be empty.";
  }
  if (majorTasks.length === 0) {
    return "Add at least one major task.";
  }

  return {
    project_name: projectName,
    project_summary: projectSummary,
    workspace_path: workspacePath,
    default_model: defaultModel,
    default_reasoning_effort: draft.reasoningEffort,
    extra_roles: extraRoles,
    tasks: majorTasks
  };
}

function cleanedRoles(roles: StarterRoleDraft[]): StarterRoleDraft[] {
  const nextRoles: StarterRoleDraft[] = [];

  for (const role of roles) {
    const name = role.name.trim();
    const responsibility = role.role.trim();
    const description = role.description.trim();

    if (!name && !responsibility && !description) {
      continue;
    }

    nextRoles.push({
      name,
      role: responsibility,
      description
    });
  }

  return nextRoles;
}

function hasIncompleteRole(roles: StarterRoleDraft[]): boolean {
  return roles.some((role) => {
    const hasAnyValue = Boolean(role.name.trim() || role.role.trim() || role.description.trim());
    return hasAnyValue && (!role.name.trim() || !role.role.trim());
  });
}

function cleanedTasks(tasks: string[]): string[] {
  const nextTasks: string[] = [];

  for (const task of tasks) {
    const trimmed = task.trim();
    if (trimmed) {
      nextTasks.push(trimmed);
    }
  }

  return nextTasks;
}


function statusDotClass(status: string): string {
  if (status === "passed") {
    return "status-working";
  }
  if (status === "failed") {
    return "status-blocked";
  }
  return "status-pending";
}

function initializationErrorText(error: unknown): string {
  const status = errorStatus(error);
  if (status === 404) {
    return "Initialize endpoint is unavailable. Start or update the backend, then retry.";
  }
  if (status === 400) {
    return "Initialize request was rejected. Check required fields.";
  }
  return "Initialize failed. Check backend status and retry.";
}

function initializedMessage(response: { queued_run_ids?: unknown[]; status?: OnboardingStatusResponse }): string {
  const queuedRuns = response.queued_run_ids?.length ?? response.status?.queued_ceo_task_runs ?? 0;
  if (queuedRuns > 0) {
    return `Workspace initialized. ${queuedRuns} task runs queued.`;
  }

  return "Workspace initialized.";
}

function errorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }

  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
