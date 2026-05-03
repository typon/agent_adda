import type { ComponentType } from "react";
import {
  BarChart3,
  BookOpenText,
  Bot,
  Eye,
  FilePlus,
  Pencil,
  Save,
  Search,
  Settings
} from "lucide-react";

export type AgentStatus =
  | "working"
  | "idle"
  | "blocked"
  | "reviewing"
  | "pending"
  | "awaiting-human"
  | "rate-limited"
  | "offline";

export type AppAgent = {
  id: string;
  name: string;
  slug?: string;
  status: AgentStatus;
  role: string;
  description?: string;
  profile?: string;
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: string;
};

export type ConversationSummary = {
  id: string;
  kind: "channel" | "dm";
  name: string;
  topic: string;
  unread: number;
  updatedAt?: string;
};

export const starterAgentRoles = ["CEO", "Founding Engineer", "Researcher", "Product Manager"] as const;

export type MissionMessage = {
  id: string;
  runId?: string | null;
  time: string;
  author: string;
  authorId: string;
  authorKind: "human" | "agent" | "system";
  body: string;
  human?: boolean;
  status?: AgentStatus;
};

export type ToolbarAction = {
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  disabled?: boolean;
  alignEnd?: boolean;
  href?: string;
  pressed?: boolean;
  onClick?: () => void;
};

export const missionToolbar: ToolbarAction[] = [
  { label: "Global Search", icon: Search },
  { label: "Stats", icon: BarChart3 },
  { label: "Settings", icon: Settings },
  { label: "Wiki Mode", icon: BookOpenText, alignEnd: true, href: "/wiki" }
];

export const opsToolbar: ToolbarAction[] = [
  { label: "Global Search", icon: Search },
  { label: "Stats", icon: BarChart3 },
  { label: "Settings", icon: Settings },
  { label: "Wiki Mode", icon: BookOpenText, alignEnd: true, href: "/wiki" }
];

export function wikiModeToolbar({
  canCreate,
  canSave,
  isEditing,
  isSaving,
  onCreatePage,
  onSavePage,
  onToggleEdit,
}: {
  canCreate: boolean;
  canSave: boolean;
  isEditing: boolean;
  isSaving: boolean;
  onCreatePage?: () => void;
  onSavePage?: () => void;
  onToggleEdit?: () => void;
}): ToolbarAction[] {
  return [
    { label: "New Page", icon: FilePlus, disabled: !canCreate, onClick: onCreatePage },
    {
      label: isEditing ? "Preview" : "Edit",
      icon: isEditing ? Eye : Pencil,
      disabled: !onToggleEdit,
      pressed: isEditing,
      onClick: onToggleEdit
    },
    { label: isSaving ? "Saving" : "Save", icon: Save, disabled: !canSave || isSaving, onClick: onSavePage },
    { label: "Global Search", icon: Search },
    { label: "Stats", icon: BarChart3 },
    { label: "Settings", icon: Settings },
    { label: "Agent Mode", icon: Bot, alignEnd: true, href: "/" }
  ];
}

export const statsToolbar: ToolbarAction[] = [
  { label: "Global Search", icon: Search },
  { label: "Settings", icon: Settings },
  { label: "Agent Mode", icon: Bot, alignEnd: true, href: "/" }
];

const knownAgentStatuses: AgentStatus[] = [
  "working",
  "idle",
  "blocked",
  "reviewing",
  "pending",
  "awaiting-human",
  "rate-limited",
  "offline"
];

export const agents: AppAgent[] = [
  { id: "demo-planner", name: "Planner", slug: "planner", status: "working", role: "Lead" },
  { id: "demo-coder", name: "Coder", slug: "coder", status: "working", role: "Implementation" },
  { id: "demo-researcher", name: "Researcher", slug: "researcher", status: "working", role: "Research" },
  { id: "demo-runner", name: "Runner", slug: "runner", status: "pending", role: "Validation" },
  { id: "demo-reviewer", name: "Reviewer", slug: "reviewer", status: "reviewing", role: "Review" }
];

export const rooms: ConversationSummary[] = [
  {
    id: "demo-launch-room",
    kind: "channel",
    name: "launch-room",
    topic: "Coordinate the product launch plan and execution.",
    unread: 2
  },
  { id: "demo-product", kind: "channel", name: "product", topic: "Product planning and launch details.", unread: 1 },
  { id: "demo-research", kind: "channel", name: "research", topic: "Market and customer research.", unread: 0 },
  { id: "demo-ops", kind: "channel", name: "ops", topic: "Run operations and human approvals.", unread: 3 }
];

export const wikis = [
  "Wiki Memory"
];

export const BotIcon = Bot;

export function normalizeAgentStatus(status: string | null | undefined): AgentStatus {
  const normalized = (status ?? "").trim().toLowerCase().replace(/_/g, "-");

  if (knownAgentStatuses.includes(normalized as AgentStatus)) {
    return normalized as AgentStatus;
  }
  if (normalized === "running" || normalized === "in-progress") {
    return "working";
  }
  if (normalized === "queued") {
    return "pending";
  }

  return "idle";
}
