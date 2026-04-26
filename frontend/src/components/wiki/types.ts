export type WikiPageState = "fresh" | "stale" | "needs-review" | "canonical";

export type WikiCalloutKind = "decision" | "risk" | "handoff" | "evidence";
export type WikiArticleMode = "preview" | "edit";

export interface WikiPageNode {
  id: string;
  title: string;
  slug: string;
  icon: string;
  state: WikiPageState;
  updatedBy: string;
  updatedAt: string;
  summary: string;
  children?: WikiPageNode[];
}

export interface WikiPage {
  id: string;
  title: string;
  slug: string;
  path: string;
  summary: string;
  content: string;
  tags: string[];
  ownerAgent: string;
  updatedBy: string;
  updatedAt: string;
  reviewState: WikiPageState;
  linkedPrs: string[];
  memoryScore: number;
}

export interface WikiBacklink {
  id: string;
  title: string;
  sourceType: "channel" | "dm" | "pr" | "wiki";
  sourceLabel: string;
  excerpt: string;
  agent: string;
  timestamp: string;
}

export interface WikiRevision {
  id: string;
  label: string;
  author: string;
  createdAt: string;
  summary: string;
  tokenDelta: number;
}

export interface WikiMemoryCallout {
  id: string;
  kind: WikiCalloutKind;
  title: string;
  body: string;
  agent: string;
  linkedPageIds: string[];
}

export interface WikiMemoryPanelProps {
  pages?: WikiPage[];
  tree?: WikiPageNode[];
  backlinks?: WikiBacklink[];
  revisions?: WikiRevision[];
  callouts?: WikiMemoryCallout[];
  activePageId?: string;
  onCreatePage?: (page: WikiPage) => void;
  onSavePage?: (page: WikiPage) => void;
  onSelectPage?: (pageId: string) => void;
  onToolbarStateChange?: (state: WikiToolbarState) => void;
}

export interface WikiToolbarState {
  canCreate: boolean;
  canSave: boolean;
  isEditing: boolean;
  isSaving: boolean;
  onCreatePage: () => void;
  onSavePage: () => void;
  onToggleEdit: () => void;
}
