import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { BookOpenText, Info, X } from "lucide-react";
import {
  demoBacklinks,
  demoCallouts,
  demoRevisions,
} from "./placeholderData";
import type {
  WikiBacklink,
  WikiArticleMode,
  WikiMemoryCallout,
  WikiMemoryPanelProps,
  WikiPage,
  WikiPageNode,
  WikiRevision,
} from "./types";
import {
  buildWikiTree,
  loadWikiMemory,
  loadWikiPageContext,
  pageToTreeNode,
  saveWikiPageDraft,
  type WikiDataSource,
} from "./wikiApi";
import { WikiEditorSplit } from "./WikiEditorSplit";
import { WikiInspector } from "./WikiInspector";
import { WikiPageTree } from "./WikiPageTree";

function createUntitledPage(index: number): WikiPage {
  const id = `new-memory-page-${index}`;
  const title = `New Memory Page ${index}`;

  return {
    id,
    title,
    slug: id,
    path: `Memory / Inbox / ${title}`,
    summary: "Fresh memory page waiting for an agent or human to fill in durable context.",
    content: [
      `# ${title}`,
      "",
      "> [!MEMORY]",
      "> Capture the durable context that future agents should know before they act.",
      "",
      "## Why this matters",
      "",
      "- ",
      "",
      "## Decisions",
      "",
      "- ",
      "",
      "## Links",
      "",
      "- Related channel:",
      "- Related PR:",
    ].join("\n"),
    tags: ["inbox"],
    ownerAgent: "Unassigned",
    updatedBy: "You",
    updatedAt: "Not saved",
    reviewState: "needs-review",
    linkedPrs: [],
    memoryScore: 30,
  };
}

function appendPageToInbox(nodes: WikiPageNode[], page: WikiPage): WikiPageNode[] {
  const inboxNode = pageToTreeNode(page);
  const nextNodes = nodes.map((node) => {
    if (node.id === "memory-inbox") {
      return { ...node, children: [...(node.children ?? []), inboxNode] };
    }
    return node;
  });

  if (nextNodes.some((node) => node.id === "memory-inbox")) {
    return nextNodes;
  }

  return [
    ...nextNodes,
    {
      id: "memory-inbox",
      title: "Inbox",
      slug: "inbox",
      icon: "IN",
      state: "needs-review",
      updatedBy: "You",
      updatedAt: "Now",
      summary: "New pages waiting to become durable memory.",
      children: [inboxNode],
    },
  ];
}

function replacePageInTree(
  nodes: WikiPageNode[],
  oldPageId: string,
  page: WikiPage,
): { nodes: WikiPageNode[]; didReplace: boolean } {
  let didReplace = false;
  const nextNodes = nodes.map((node) => {
    if (node.id === oldPageId || node.id === page.id) {
      didReplace = true;
      return pageToTreeNode(page);
    }

    if (!node.children) return node;

    const childResult = replacePageInTree(node.children, oldPageId, page);
    if (!childResult.didReplace) return node;

    didReplace = true;
    return { ...node, children: childResult.nodes };
  });

  return { nodes: nextNodes, didReplace };
}

function replaceOrAppendPageInTree(nodes: WikiPageNode[], oldPageId: string, page: WikiPage): WikiPageNode[] {
  const result = replacePageInTree(nodes, oldPageId, page);
  return result.didReplace ? result.nodes : appendPageToInbox(nodes, page);
}

export function WikiMemoryPanel({
  pages,
  tree,
  backlinks = demoBacklinks,
  revisions = demoRevisions,
  callouts = demoCallouts,
  activePageId,
  onCreatePage,
  onSavePage,
  onSelectPage,
  onToolbarStateChange,
}: WikiMemoryPanelProps) {
  const [localPages, setLocalPages] = useState<WikiPage[]>(pages ?? []);
  const [localTree, setLocalTree] = useState<WikiPageNode[]>(tree ?? []);
  const [selectedPageId, setSelectedPageId] = useState(activePageId ?? pages?.[0]?.id ?? "");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [lastSavedLabel, setLastSavedLabel] = useState("Loading shared memory...");
  const [contextLabel, setContextLabel] = useState("Loading page context...");
  const [localRevisions, setLocalRevisions] = useState<WikiRevision[]>(revisions);
  const [localBacklinks, setLocalBacklinks] = useState<WikiBacklink[]>(backlinks);
  const [localCallouts, setLocalCallouts] = useState<WikiMemoryCallout[]>(callouts);
  const [memorySource, setMemorySource] = useState<WikiDataSource>(pages ? "backend" : "local");
  const [isLoading, setIsLoading] = useState(!pages);
  const [isSaving, setIsSaving] = useState(false);
  const [articleMode, setArticleMode] = useState<WikiArticleMode>("preview");
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);

  const activePage = useMemo(() => {
    return localPages.find((page) => page.id === selectedPageId) ?? localPages[0];
  }, [localPages, selectedPageId]);

  const draftContent = activePage ? drafts[activePage.id] ?? activePage.content : "";
  const isDirty = activePage ? draftContent !== activePage.content : false;

  useEffect(() => {
    const selectHashPage = () => {
      const hash = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
      if (!hash) {
        return;
      }

      const page = localPages.find((candidate) => candidate.id === hash || candidate.slug === hash);
      if (page) {
        setSelectedPageId(page.id);
      }
    };

    selectHashPage();
    window.addEventListener("hashchange", selectHashPage);
    return () => window.removeEventListener("hashchange", selectHashPage);
  }, [localPages]);

  const relevantCallouts = useMemo(() => {
    if (!activePage) return localCallouts;
    return localCallouts.filter(
      (callout) =>
        callout.linkedPageIds.includes(activePage.id) ||
        callout.linkedPageIds.length === 0 ||
        activePage.tags.some((tag) => callout.body.toLowerCase().includes(tag.toLowerCase())),
    );
  }, [activePage, localCallouts]);

  const handleSelectPage = useCallback((pageId: string) => {
    setSelectedPageId(pageId);
    setMobileTreeOpen(false);
    onSelectPage?.(pageId);
  }, [onSelectPage]);

  const handleCreatePage = useCallback(() => {
    const page = createUntitledPage(localPages.length + 1);
    setLocalPages((currentPages) => [...currentPages, page]);
    setLocalTree((currentTree) => appendPageToInbox(currentTree, page));
    setSelectedPageId(page.id);
    setDrafts((currentDrafts) => ({ ...currentDrafts, [page.id]: page.content }));
    setLastSavedLabel("New page created locally");
    setMemorySource((currentSource) => (currentSource === "backend" ? currentSource : "local"));
    setArticleMode("edit");
    onCreatePage?.(page);
  }, [localPages.length, onCreatePage]);

  const handleSavePage = useCallback(async () => {
    if (!activePage || isSaving) return;

    setIsSaving(true);
    setLastSavedLabel("Saving wiki memory...");

    try {
      const result = await saveWikiPageDraft(activePage, draftContent);
      const savedPage = result.page;

      setLocalPages((currentPages) => {
        const nextPages: WikiPage[] = [];
        let didReplace = false;

        for (const page of currentPages) {
          if (page.id === activePage.id || page.id === savedPage.id) {
            if (!didReplace) {
              nextPages.push(savedPage);
              didReplace = true;
            }
            continue;
          }

          nextPages.push(page);
        }

        return didReplace ? nextPages : [...nextPages, savedPage];
      });
      setLocalTree((currentTree) => replaceOrAppendPageInTree(currentTree, activePage.id, savedPage));
      setSelectedPageId(savedPage.id);
      setDrafts((currentDrafts) => {
        const nextDrafts = { ...currentDrafts };
        delete nextDrafts[activePage.id];
        delete nextDrafts[savedPage.id];
        return nextDrafts;
      });

      if (result.revision) {
        setLocalRevisions((currentRevisions) => [result.revision as WikiRevision, ...currentRevisions]);
      }

      setMemorySource(result.source === "backend" ? "backend" : "local");
      setLastSavedLabel(result.message);
      onSavePage?.(savedPage);
    } catch (error) {
      setLastSavedLabel(errorMessage(error, "Save failed; draft remains unsaved."));
    } finally {
      setIsSaving(false);
    }
  }, [activePage, draftContent, isSaving, onSavePage]);

  const handleToggleEdit = useCallback(() => {
    setArticleMode((mode) => (mode === "edit" ? "preview" : "edit"));
  }, []);

  useEffect(() => {
    onToolbarStateChange?.({
      canCreate: !isLoading,
      canSave: Boolean(activePage && isDirty),
      isEditing: articleMode === "edit",
      isSaving,
      onCreatePage: handleCreatePage,
      onSavePage: handleSavePage,
      onToggleEdit: handleToggleEdit,
    });
  }, [
    activePage,
    articleMode,
    handleCreatePage,
    handleSavePage,
    handleToggleEdit,
    isDirty,
    isLoading,
    isSaving,
    onToolbarStateChange,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const usesCommandKey = event.metaKey || event.ctrlKey;
      if (!usesCommandKey) return;

      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSavePage();
      }

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        handleCreatePage();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleCreatePage, handleSavePage]);

  useEffect(() => {
    if (!pages) return;

    setLocalPages(pages);
    setLocalTree(tree ?? buildWikiTree(pages));
    setSelectedPageId((currentPageId) =>
      pages.some((page) => page.id === currentPageId) ? currentPageId : activePageId ?? pages[0]?.id ?? "",
    );
    setMemorySource("backend");
    setIsLoading(false);
    setLastSavedLabel("Loaded provided wiki memory.");
  }, [activePageId, pages, tree]);

  useEffect(() => {
    if (tree) {
      setLocalTree(tree);
    }
  }, [tree]);

  useEffect(() => {
    setLocalBacklinks(backlinks);
  }, [backlinks]);

  useEffect(() => {
    setLocalRevisions(revisions);
  }, [revisions]);

  useEffect(() => {
    setLocalCallouts(callouts);
  }, [callouts]);

  useEffect(() => {
    if (pages) return;

    let didCancel = false;
    setIsLoading(true);

    loadWikiMemory()
      .then((result) => {
        if (didCancel) return;

        setLocalPages(result.pages);
        setLocalTree(result.tree);
        setLocalCallouts(result.callouts);
        setMemorySource(result.source);
        setLastSavedLabel(result.message);
        setSelectedPageId((currentPageId) =>
          result.pages.some((page) => page.id === currentPageId) ? currentPageId : result.pages[0]?.id ?? "",
        );
      })
      .finally(() => {
        if (!didCancel) {
          setIsLoading(false);
        }
      });

    return () => {
      didCancel = true;
    };
  }, [pages]);

  useEffect(() => {
    if (!activePage) return;

    let didCancel = false;
    setContextLabel("Loading page context...");

    loadWikiPageContext(activePage, localPages, memorySource)
      .then((result) => {
        if (didCancel) return;

        setLocalBacklinks(result.backlinks);
        setLocalRevisions(result.revisions);
        setContextLabel(result.message);
      })
      .catch(() => {
        if (didCancel) return;

        setLocalBacklinks(backlinks);
        setLocalRevisions(revisions);
        setContextLabel("Using local wiki context fallback.");
      });

    return () => {
      didCancel = true;
    };
  }, [activePage, backlinks, localPages, memorySource, revisions]);

  if (!activePage) {
    return (
      <div className="grid gap-3 border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#c0c0c0] p-4 text-sm text-black">
        <p>{isLoading ? "Loading wiki memory..." : lastSavedLabel || "No wiki pages are available yet."}</p>
        {!isLoading ? (
          <button
            className="w-fit border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#dcdcdc] px-3 py-2 font-bold text-black active:border-l-[#404040] active:border-t-[#404040] active:border-r-white active:border-b-white"
            onClick={handleCreatePage}
            type="button"
          >
            New Page
          </button>
        ) : null}
      </div>
    );
  }

  const sourceLabel =
    memorySource === "backend"
      ? "Shared memory online"
      : memorySource === "local"
        ? "Local memory pending backend sync"
        : "Demo memory fallback";

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-1 overflow-hidden bg-[#808080] p-1 text-[12px] text-black md:gap-2 md:p-2 md:text-[15px]">
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-1 md:gap-2 xl:grid-cols-[276px_minmax(0,1fr)_20rem]">
        <div className="hidden min-h-0 xl:block">
          <WikiPageTree
            nodes={localTree}
            activePageId={activePage.id}
            query={query}
            onQueryChange={setQuery}
            onSelectPage={handleSelectPage}
            onCreatePage={handleCreatePage}
          />
        </div>
        <main className="flex min-h-0 flex-col gap-1 md:gap-2">
          <section className="border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] bg-[#dcdcdc] p-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-base font-black md:text-xl">{activePage.title}</h2>
                <p className="mt-1 line-clamp-2 max-w-4xl text-[11px] leading-4 text-[#202020] md:text-sm md:leading-5">{activePage.summary}</p>
                <div className="mt-2 flex gap-1 md:hidden">
                  <button
                    className="win-button h-7 min-h-0 px-2 py-0 text-[11px]"
                    onClick={handleCreatePage}
                    type="button"
                  >
                    New
                  </button>
                  <button
                    className="win-button h-7 min-h-0 px-2 py-0 text-[11px]"
                    onClick={handleToggleEdit}
                    type="button"
                  >
                    {articleMode === "edit" ? "Preview" : "Edit"}
                  </button>
                  <button
                    className="win-button h-7 min-h-0 px-2 py-0 text-[11px]"
                    disabled={!isDirty || isSaving}
                    onClick={() => void handleSavePage()}
                    type="button"
                  >
                    {isSaving ? "Saving" : "Save"}
                  </button>
                </div>
              </div>
              <div className="flex shrink-0 gap-1 xl:hidden">
                <button
                  className="win-button flex h-7 min-h-0 items-center gap-1 px-2 py-0 text-[11px]"
                  onClick={() => setMobileTreeOpen(true)}
                  type="button"
                >
                  <BookOpenText size={13} />
                  Pages
                </button>
                <button
                  className="win-button flex h-7 min-h-0 items-center gap-1 px-2 py-0 text-[11px]"
                  onClick={() => setMobileInspectorOpen(true)}
                  type="button"
                >
                  <Info size={13} />
                  Info
                </button>
              </div>
              <div className="hidden min-w-48 grid-cols-2 gap-1 text-xs md:grid">
                <span className="border border-[#808080] bg-white px-2 py-1">Owner: {activePage.ownerAgent}</span>
                <span className="border border-[#808080] bg-white px-2 py-1">Review: {activePage.reviewState}</span>
                <span className="border border-[#808080] bg-white px-2 py-1">PRs: {activePage.linkedPrs.length}</span>
                <span className="border border-[#808080] bg-white px-2 py-1">Score: {activePage.memoryScore}%</span>
              </div>
            </div>
          </section>
          <WikiEditorSplit
            page={activePage}
            draftContent={draftContent}
            mode={articleMode}
            callouts={relevantCallouts}
            onDraftChange={(content) =>
              setDrafts((currentDrafts) => ({ ...currentDrafts, [activePage.id]: content }))
            }
          />
        </main>
        <div className="hidden min-h-0 xl:block">
          <WikiInspector page={activePage} backlinks={localBacklinks} revisions={localRevisions} />
        </div>
      </div>
      <footer className="hidden grid-cols-1 gap-2 border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#c0c0c0] p-2 text-xs text-black md:grid md:grid-cols-[1fr_minmax(0,16rem)_minmax(0,22rem)_auto_auto]">
        <span className="truncate">{sourceLabel} - {localPages.length} pages indexed for agent recall</span>
        <span className="truncate border border-[#808080] bg-[#dcdcdc] px-2 py-1">{isDirty ? "Unsaved changes" : lastSavedLabel}</span>
        <span className="truncate border border-[#808080] bg-[#dcdcdc] px-2 py-1">{contextLabel}</span>
        <span className="border border-[#808080] bg-[#dcdcdc] px-2 py-1">Cmd+K: search memory</span>
        <span className="border border-[#808080] bg-[#dcdcdc] px-2 py-1">Cmd+S: save page</span>
      </footer>
      <WikiMobileSheet
        onClose={() => setMobileTreeOpen(false)}
        open={mobileTreeOpen}
        title="Wiki Pages"
      >
        <WikiPageTree
          nodes={localTree}
          activePageId={activePage.id}
          query={query}
          onQueryChange={setQuery}
          onSelectPage={handleSelectPage}
          onCreatePage={handleCreatePage}
        />
      </WikiMobileSheet>
      <WikiMobileSheet
        onClose={() => setMobileInspectorOpen(false)}
        open={mobileInspectorOpen}
        title="Memory Info"
      >
        <WikiInspector page={activePage} backlinks={localBacklinks} revisions={localRevisions} />
      </WikiMobileSheet>
    </div>
  );
}

export default WikiMemoryPanel;

function WikiMobileSheet({
  children,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="aa-mobile-sheet-backdrop xl:hidden" role="presentation" onClick={onClose}>
      <section
        aria-label={title}
        className="aa-mobile-sheet"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="win-titlebar justify-between">
          <span>{title}</span>
          <button
            aria-label={`Close ${title}`}
            className="win-button grid h-6 min-h-0 w-7 place-items-center p-0"
            onClick={onClose}
            type="button"
          >
            <X size={13} />
          </button>
        </div>
        <div className="app-scrollbar max-h-[60vh] overflow-auto p-2">
          {children}
        </div>
      </section>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
