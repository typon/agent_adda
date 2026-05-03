import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  loadMissionControlRecords,
  type ApiAgent,
  type ApiConversation
} from "@/lib/api/missionControl";
import { WindowChrome } from "./WindowChrome";
import { normalizeAgentStatus, wikiModeToolbar, type AppAgent, type ConversationSummary } from "./types";
import { WikiMemoryPanel } from "../wiki";
import type { WikiToolbarState } from "../wiki/types";

export function WikiPage() {
  const [agentRows, setAgentRows] = useState<AppAgent[]>([]);
  const [conversationRows, setConversationRows] = useState<ConversationSummary[]>([]);
  const [wikiControls, setWikiControls] = useState<WikiToolbarState | null>(null);
  const [notice, setNotice] = useState<string | null>("Connecting to API...");
  const sourceLabel = notice ? wikiSourceLabel(notice) : "Backend connected";
  const toolbar = useMemo(
    () =>
      wikiModeToolbar({
        canCreate: Boolean(wikiControls?.canCreate),
        canSave: Boolean(wikiControls?.canSave),
        isEditing: Boolean(wikiControls?.isEditing),
        isSaving: Boolean(wikiControls?.isSaving),
        onCreatePage: wikiControls?.onCreatePage,
        onSavePage: wikiControls?.onSavePage,
        onToggleEdit: wikiControls?.onToggleEdit,
      }),
    [wikiControls],
  );

  useEffect(() => {
    const controller = new AbortController();

    loadMissionControlRecords(controller.signal)
      .then((records) => {
        if (controller.signal.aborted) {
          return;
        }
        setAgentRows(records.agents.map(mapApiAgent));
        setConversationRows(records.conversations.map(mapApiConversation));
        setNotice(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAgentRows([]);
          setConversationRows([]);
          setNotice("API unavailable. Wiki navigation is offline.");
        }
      });

    return () => controller.abort();
  }, []);

  return (
    <WindowChrome
      title="Agent Adda - Wiki Memory"
      toolbar={toolbar}
      statusItems={
        <>
          <StatusCell>{agentRows.length} agents</StatusCell>
          <StatusCell>{conversationRows.length} rooms</StatusCell>
          <StatusCell>{sourceLabel}</StatusCell>
          <StatusCell>Wiki mode</StatusCell>
        </>
      }
    >
      <div className="h-full min-h-0 p-1">
        <WikiMemoryPanel onToolbarStateChange={setWikiControls} />
      </div>
    </WindowChrome>
  );
}

function StatusCell({ children }: { children: ReactNode }) {
  return (
    <div className="win-panel flex min-w-0 items-center truncate px-3">
      {children}
    </div>
  );
}

function wikiSourceLabel(notice: string): string {
  return notice.startsWith("Connecting") ? "Loading" : "Offline";
}

function mapApiAgent(agent: ApiAgent): AppAgent {
  return {
    id: agent.id,
    name: agent.name || agent.slug || agent.id,
    slug: agent.slug,
    status: normalizeAgentStatus(agent.status),
    role: agent.role || "Agent",
    description: agent.description,
    profile: agent.profile,
    systemPrompt: agent.system_prompt,
    model: agent.model,
    reasoningEffort: agent.reasoning_effort
  };
}

function mapApiConversation(conversation: ApiConversation): ConversationSummary {
  return {
    id: conversation.id,
    kind: conversation.kind,
    name: conversation.name || conversation.slug || conversation.id,
    topic: conversation.topic,
    unread: 0,
    updatedAt: conversation.updated_at ?? conversation.created_at
  };
}
