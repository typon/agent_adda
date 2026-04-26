import type { WikiBacklink, WikiPage, WikiRevision } from "./types";

interface WikiInspectorProps {
  page: WikiPage;
  backlinks: WikiBacklink[];
  revisions: WikiRevision[];
}

const sourceTypeLabel: Record<WikiBacklink["sourceType"], string> = {
  channel: "CHAN",
  dm: "DM",
  pr: "PR",
  wiki: "WIKI",
};

export function WikiInspector({ page, backlinks, revisions }: WikiInspectorProps) {
  return (
    <aside className="flex min-h-0 w-full shrink-0 flex-col gap-2 overflow-auto border-2 border-l-white border-t-white border-r-[#404040] border-b-[#404040] bg-[#c0c0c0] p-2 2xl:w-80">
      <section className="border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] bg-[#dcdcdc]">
        <div className="bg-[#000080] px-2 py-1 text-sm font-bold text-white">Memory Health</div>
        <div className="space-y-2 p-3 text-sm text-black">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs font-bold">
              <span>Confidence</span>
              <span>{page.memoryScore}%</span>
            </div>
            <div className="h-4 border-2 border-l-[#404040] border-t-[#404040] border-r-white border-b-white bg-white">
              <div className="h-full bg-[#008000]" style={{ width: `${page.memoryScore}%` }} />
            </div>
          </div>
          <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            <dt className="font-bold">Owner</dt>
            <dd>{page.ownerAgent}</dd>
            <dt className="font-bold">Review</dt>
            <dd>{page.reviewState}</dd>
            <dt className="font-bold">Tags</dt>
            <dd className="flex flex-wrap gap-1">
              {page.tags.map((tag) => (
                <span key={tag} className="border border-[#808080] bg-white px-1">
                  {tag}
                </span>
              ))}
            </dd>
            <dt className="font-bold">Linked PRs</dt>
            <dd>{page.linkedPrs.length ? page.linkedPrs.join(", ") : "None yet"}</dd>
          </dl>
        </div>
      </section>

      <section className="border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] bg-[#dcdcdc]">
        <div className="bg-[#000080] px-2 py-1 text-sm font-bold text-white">Backlinks</div>
        <div className="divide-y divide-[#a0a0a0]">
          {backlinks.length ? (
            backlinks.map((backlink) => (
              <article key={backlink.id} className="p-2 text-xs text-black">
                <div className="mb-1 flex items-center gap-2">
                  <span className="border border-[#404040] bg-white px-1 font-bold">
                    {sourceTypeLabel[backlink.sourceType]}
                  </span>
                  <span className="truncate font-bold">{backlink.sourceLabel}</span>
                  <span className="ml-auto text-[#404040]">{backlink.timestamp}</span>
                </div>
                <h4 className="text-sm font-bold">{backlink.title}</h4>
                <p className="mt-1 leading-5">{backlink.excerpt}</p>
                <div className="mt-1 text-[#404040]">via {backlink.agent}</div>
              </article>
            ))
          ) : (
            <p className="p-2 text-xs text-[#404040]">No backlinks found for this page yet.</p>
          )}
        </div>
      </section>

      <section className="border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] bg-[#dcdcdc]">
        <div className="bg-[#000080] px-2 py-1 text-sm font-bold text-white">Revision History</div>
        <ol className="divide-y divide-[#a0a0a0]">
          {revisions.length ? (
            revisions.map((revision) => (
              <li key={revision.id} className="p-2 text-xs text-black">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                  <span className="min-w-0 truncate font-bold">{revision.label}</span>
                  <span className="shrink-0 text-[#404040]">{revision.createdAt}</span>
                </div>
                <p className="mt-1 leading-5">{revision.summary}</p>
                <div className="mt-1 flex items-center justify-between text-[#404040]">
                  <span>{revision.author}</span>
                  <span>+{revision.tokenDelta} tokens</span>
                </div>
              </li>
            ))
          ) : (
            <li className="p-2 text-xs text-[#404040]">No revisions loaded for this page yet.</li>
          )}
        </ol>
      </section>

      <section className="border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] bg-[#fffbe8] p-3 text-xs leading-5 text-black">
        <div className="mb-1 font-bold text-[#000080]">Agent memory rules</div>
        <p>
          Search memory before work, cite pages while discussing work, and save durable
          findings here before marking a run complete.
        </p>
      </section>
    </aside>
  );
}
