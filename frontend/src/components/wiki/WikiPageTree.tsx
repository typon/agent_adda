import type { WikiPageNode } from "./types";

interface WikiPageTreeProps {
  nodes: WikiPageNode[];
  activePageId: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectPage: (pageId: string) => void;
  onCreatePage: () => void;
}

const stateLabel: Record<WikiPageNode["state"], string> = {
  canonical: "OK",
  fresh: "New",
  stale: "Old",
  "needs-review": "Check",
};

const stateClassName: Record<WikiPageNode["state"], string> = {
  canonical: "bg-[#008000] text-white",
  fresh: "bg-[#000080] text-white",
  stale: "bg-[#808080] text-white",
  "needs-review": "bg-[#ffff99] text-black",
};

function nodeMatches(node: WikiPageNode, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = `${node.title} ${node.slug} ${node.summary} ${node.updatedBy}`.toLowerCase();
  return haystack.includes(query.trim().toLowerCase());
}

function visibleNodes(nodes: WikiPageNode[], query: string): WikiPageNode[] {
  return nodes
    .map((node) => {
      const children = node.children ? visibleNodes(node.children, query) : undefined;
      if (nodeMatches(node, query) || (children && children.length > 0)) {
        return { ...node, children };
      }
      return null;
    })
    .filter(Boolean) as WikiPageNode[];
}

function TreeNode({
  node,
  depth,
  activePageId,
  onSelectPage,
}: {
  node: WikiPageNode;
  depth: number;
  activePageId: string;
  onSelectPage: (pageId: string) => void;
}) {
  const isActive = node.id === activePageId;
  const isBranch = Boolean(node.children?.length);

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelectPage(node.id)}
        className={`grid min-h-8 w-full grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-2 border border-transparent px-2 text-left text-sm ${
          isActive
            ? "border-[#000080] bg-[#000080] text-white"
            : "text-black hover:border-[#808080] hover:bg-[#dcdcdc]"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span
          className={`grid h-5 w-6 place-items-center border text-[9px] font-black ${
            isActive ? "border-white bg-[#c0c0c0] text-[#000080]" : "border-[#808080] bg-white text-black"
          }`}
        >
          {node.icon}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-bold">{node.title}</span>
          <span className={`block truncate text-[11px] ${isActive ? "text-[#e8e8ff]" : "text-[#404040]"}`}>
            {isBranch ? "Memory folder" : `Edited by ${node.updatedBy}`}
          </span>
        </span>
        <span
          aria-label={stateLabel[node.state]}
          className={`min-w-11 border border-[#404040] px-1 py-0.5 text-center text-[10px] font-bold ${stateClassName[node.state]}`}
        >
          <span aria-hidden="true">{stateLabel[node.state]}</span>
        </span>
      </button>
      {node.children?.length ? (
        <ul className="border-l border-[#808080] pl-0">
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activePageId={activePageId}
              onSelectPage={onSelectPage}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function WikiPageTree({
  nodes,
  activePageId,
  query,
  onQueryChange,
  onSelectPage,
  onCreatePage,
}: WikiPageTreeProps) {
  const filteredNodes = visibleNodes(nodes, query);

  return (
    <aside className="flex h-72 min-h-0 w-full shrink-0 flex-col overflow-hidden border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#c0c0c0] xl:h-full 2xl:w-72">
      <div className="bg-[#000080] px-2 py-1 text-sm font-bold text-white">Wiki Memory</div>
      <div className="border-b border-[#808080] p-2">
        <label className="mb-1 block text-xs font-bold text-black" htmlFor="wiki-tree-search">
          Find memory page
        </label>
        <input
          id="wiki-tree-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="architecture, PRs, runbook..."
          className="h-8 w-full border-2 border-l-[#404040] border-t-[#404040] border-r-white border-b-white bg-white px-2 text-sm text-black outline-none"
        />
      </div>
      <div className="flex items-center gap-2 border-b border-[#808080] p-2">
        <button
          type="button"
          onClick={onCreatePage}
          className="h-8 border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#dcdcdc] px-3 text-sm font-bold text-black active:border-l-[#404040] active:border-t-[#404040] active:border-r-white active:border-b-white"
        >
          + Page
        </button>
        <span className="truncate text-xs text-[#202020]">Agents read this before acting.</span>
      </div>
      <nav className="app-scrollbar min-h-0 flex-1 overflow-auto p-2" aria-label="Wiki pages">
        {filteredNodes.length ? (
          <ul className="space-y-1">
            {filteredNodes.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                activePageId={activePageId}
                onSelectPage={onSelectPage}
              />
            ))}
          </ul>
        ) : (
          <div className="border border-[#808080] bg-white p-3 text-sm text-[#404040]">
            No memory pages match this search.
          </div>
        )}
      </nav>
    </aside>
  );
}
