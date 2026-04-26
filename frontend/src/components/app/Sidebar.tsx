import { useEffect, useState, type ReactNode } from "react";
import { BookOpenText, Bot, ChevronDown, ChevronRight, MessageSquare, Monitor, Plus } from "lucide-react";
import { getOnboardingStatus } from "@/lib/api/onboarding";
import type { AppAgent, ConversationSummary } from "./types";
import { agents as demoAgents, normalizeAgentStatus, rooms as demoRooms, wikis } from "./types";

type SidebarProps = {
  agents?: AppAgent[];
  conversations?: ConversationSummary[];
  activeConversationId?: string;
  loading?: boolean;
  notice?: string | null;
  onCreateAgent?: () => void;
  onCreateRoom?: () => void;
  onSelectConversation?: (conversationId: string) => void;
};

export function Sidebar({
  agents = demoAgents,
  conversations = demoRooms,
  activeConversationId = demoRooms[0]?.id,
  loading = false,
  notice = null,
  onCreateAgent,
  onCreateRoom,
  onSelectConversation
}: SidebarProps) {
  const [projectName, setProjectName] = useState("Project");
  const channelConversations = conversations.filter((conversation) => conversation.kind === "channel");
  const dmConversations = conversations.filter((conversation) => conversation.kind === "dm");
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  useEffect(() => {
    const controller = new AbortController();

    getOnboardingStatus(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) {
          setProjectName(displayProjectName(status.project_name));
        }
      })
      .catch(() => undefined);

    function handleProjectNameUpdated(event: Event) {
      if (event instanceof CustomEvent && typeof event.detail?.projectName === "string") {
        setProjectName(displayProjectName(event.detail.projectName));
      }
    }

    window.addEventListener("aa:project-name-updated", handleProjectNameUpdated);

    return () => {
      controller.abort();
      window.removeEventListener("aa:project-name-updated", handleProjectNameUpdated);
    };
  }, []);

  return (
    <aside className="win-panel flex min-h-0 w-full shrink-0 flex-col overflow-hidden lg:w-[276px] lg:flex-none">
      <div className="flex items-center gap-3 border-b border-[#777] px-3 py-3 sm:p-4">
        <Monitor size={32} className="shrink-0 sm:h-9 sm:w-9" />
        <strong className="truncate text-sm sm:text-base">{projectName}</strong>
      </div>
      {notice ? (
        <div className="border-b border-[#777] bg-[#fff8c8] px-3 py-2 text-sm leading-tight">
          {notice}
        </div>
      ) : null}

      <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
        <SidebarSection
          action={onCreateRoom ? { label: "Add room", onClick: onCreateRoom } : undefined}
          title="Rooms"
          defaultOpen
        >
          {channelConversations.length > 0 ? (
            channelConversations.map((room) => (
              <ConversationRow
                active={room.id === activeConversationId}
                conversation={room}
                key={room.id}
                onSelectConversation={onSelectConversation}
              />
            ))
          ) : (
            <SidebarEmpty label={loading ? "Loading rooms..." : "No rooms"} />
          )}
        </SidebarSection>

        <SidebarSection
          action={onCreateAgent ? { label: "Add agent", onClick: onCreateAgent } : undefined}
          title="Direct Messages"
        >
          {dmConversations.length > 0 ? (
            dmConversations.map((conversation) => (
              <ConversationRow
                active={conversation.id === activeConversationId}
                agent={agentForConversation(conversation, agentsById, agents)}
                conversation={conversation}
                key={conversation.id}
                onSelectConversation={onSelectConversation}
              />
            ))
          ) : agents.length > 0 ? (
            agents.map((agent) => (
              <div className="flex min-h-10 min-w-0 items-center gap-2 overflow-hidden px-3 py-1" key={agent.id}>
                <Bot size={16} className="shrink-0" />
                <span className="block min-w-0 flex-1" title={agentTitle(agent)}>
                  <span className="block truncate leading-tight">{compactSidebarLabel(agentDisplayName(agent), 30)}</span>
                  {agentDisplayRole(agent) ? (
                    <span className="block truncate text-xs leading-tight text-[var(--adda-muted)]">
                      {compactSidebarLabel(agentDisplayRole(agent), 30)}
                    </span>
                  ) : null}
                </span>
                <AgentStatusDot status={agent.status} />
              </div>
            ))
          ) : (
            <SidebarEmpty label="No DMs" />
          )}
        </SidebarSection>

        <SidebarSection title="Wikis" defaultOpen>
          {wikis.map((wiki) => (
            <a className="flex h-8 min-w-0 items-center gap-2 px-3" href="/wiki" key={wiki}>
              <BookOpenText size={16} className="shrink-0" />
              <span className="truncate">{wiki}</span>
            </a>
          ))}
        </SidebarSection>
      </div>
    </aside>
  );
}

function displayProjectName(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "Project";
}

function ConversationRow({
  active,
  agent,
  conversation,
  onSelectConversation
}: {
  active: boolean;
  agent?: AppAgent | null;
  conversation: ConversationSummary;
  onSelectConversation?: (conversationId: string) => void;
}) {
  const Icon = conversation.kind === "dm" ? Bot : MessageSquare;
  const label = conversation.kind === "dm" && agent ? agentDisplayName(agent) : conversation.name;
  const secondaryLabel = conversation.kind === "dm" && agent ? agentDisplayRole(agent) : "";
  const fullChannelLabel = `# ${label}`;
  const visibleLabel = conversation.kind === "channel" ? compactSidebarLabel(fullChannelLabel, 28) : compactSidebarLabel(label, 30);
  const accessibleLabel = conversation.kind === "channel" ? fullChannelLabel : label;
  const titleLabel = secondaryLabel ? `${label} (${secondaryLabel})` : accessibleLabel;

  return (
    <button
      className={`flex ${secondaryLabel ? "h-10" : "h-8"} w-full min-w-0 items-center gap-2 overflow-hidden px-3 text-left ${
        active ? "bg-[var(--adda-blue)] text-white" : ""
      }`}
      aria-label={accessibleLabel}
      onClick={() => onSelectConversation?.(conversation.id)}
      type="button"
      title={titleLabel}
    >
      <Icon size={17} className="shrink-0" />
      <span className="block min-w-0 flex-1">
        {visibleLabel}
        {secondaryLabel ? (
          <span className={`block truncate text-xs ${active ? "text-white/80" : "text-[var(--adda-muted)]"}`}>
            {compactSidebarLabel(secondaryLabel, 30)}
          </span>
        ) : null}
      </span>
      {conversation.kind === "dm" && agent ? (
        <AgentStatusDot status={agent.status} />
      ) : null}
      {conversation.unread > 0 ? (
        <span className={`grid h-5 min-w-5 shrink-0 place-items-center px-1 text-xs ${
          active ? "bg-white text-black" : "bg-[var(--adda-blue)] text-white"
        }`}>
          {conversation.unread}
        </span>
      ) : null}
    </button>
  );
}

function AgentStatusDot({ status }: { status: string }) {
  return (
    <span
      className={`status-dot ${sidebarAgentStatusClass(status)} ml-auto shrink-0`}
      title={status}
    />
  );
}

function sidebarAgentStatusClass(status: string): string {
  const normalized = normalizeAgentStatus(status);
  if (normalized === "working") {
    return "status-running";
  }
  if (normalized === "pending") {
    return "status-queued";
  }

  return `status-${normalized}`;
}

function agentForConversation(
  conversation: ConversationSummary,
  agentsById: Map<string, AppAgent>,
  agents: AppAgent[]
): AppAgent | null {
  if (conversation.kind !== "dm") {
    return null;
  }

  if (conversation.id.startsWith("dm_")) {
    const agent = agentsById.get(conversation.id.slice(3));
    if (agent) {
      return agent;
    }
  }

  const conversationName = normalizeLookup(conversation.name);
  return agents.find((agent) => normalizeLookup(agent.name) === conversationName || normalizeLookup(agent.role) === conversationName) ?? null;
}

function agentDisplayName(agent: AppAgent): string {
  const name = agent.name.trim();
  const role = agent.role.trim();

  return name || role || "Unnamed";
}

function agentDisplayRole(agent: AppAgent): string {
  return agent.role.trim();
}

function agentTitle(agent: AppAgent): string {
  const role = agentDisplayRole(agent);
  return role ? `${agentDisplayName(agent)} (${role})` : agentDisplayName(agent);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase();
}

function compactSidebarLabel(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function SidebarEmpty({ label }: { label: string }) {
  return <div className="flex h-8 items-center px-3 text-sm text-[var(--adda-muted)]">{label}</div>;
}

function SidebarSection({
  action,
  title,
  defaultOpen = true,
  children
}: {
  action?: { label: string; onClick: () => void };
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const Icon = open ? ChevronDown : ChevronRight;
  const contentId = `sidebar-section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <section className="border-b border-[#777] py-2">
      <h2 className="flex h-8 items-center gap-2 px-3 text-base font-bold">
        <button
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${title}`}
          className="win-button grid h-6 min-h-0 w-6 place-items-center p-0"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          <Icon size={13} />
        </button>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {action ? (
          <button
            aria-label={action.label}
            className="win-button grid h-6 min-h-0 w-6 shrink-0 place-items-center p-0"
            onClick={action.onClick}
            title={action.label}
            type="button"
          >
            <Plus size={13} />
          </button>
        ) : null}
      </h2>
      <div hidden={!open} id={contentId}>{children}</div>
    </section>
  );
}
