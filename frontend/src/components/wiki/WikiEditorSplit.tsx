import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugFromTitle } from "./wikiApi";
import type { WikiArticleMode, WikiMemoryCallout, WikiPage } from "./types";
import { WikiMemoryCallout as MemoryCallout } from "./WikiMemoryCallout";

interface WikiEditorSplitProps {
  page: WikiPage;
  draftContent: string;
  mode: WikiArticleMode;
  callouts: WikiMemoryCallout[];
  onDraftChange: (content: string) => void;
}

const markdownComponents: Components = {
  h1({ children }) {
    return <h1 className="mb-4 border-b border-[#808080] pb-2 text-2xl font-black leading-tight">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="mt-6 mb-2 text-lg font-black leading-tight text-[#000080]">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="mt-4 mb-2 text-base font-black leading-tight">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="mt-4 mb-2 text-sm font-black uppercase">{children}</h4>;
  },
  p({ children }) {
    return <p className="my-3 leading-6">{children}</p>;
  },
  a({ href, children }) {
    return (
      <a className="font-bold text-[#000080] underline" href={href}>
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-3 grid gap-1 pl-5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-3 grid list-decimal gap-1 pl-7">{children}</ol>;
  },
  li({ children }) {
    return <li className="pl-1 leading-6 marker:text-[#000080]">{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-4 border-2 border-l-[#000080] border-t-white border-r-[#808080] border-b-[#808080] bg-[#fffbe8] px-3 py-2">
        {children}
      </blockquote>
    );
  },
  table({ children }) {
    return (
      <div className="my-4 overflow-auto border-2 border-l-[#404040] border-t-[#404040] border-r-white border-b-white bg-white">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    );
  },
  th({ children }) {
    return <th className="border border-[#808080] bg-[#dcdcdc] px-2 py-1 text-left font-black">{children}</th>;
  },
  td({ children }) {
    return <td className="border border-[#a0a0a0] px-2 py-1 align-top">{children}</td>;
  },
  pre({ children }) {
    return (
      <pre className="my-4 max-h-[32rem] overflow-auto border-2 border-l-[#404040] border-t-[#404040] border-r-white border-b-white bg-[#f7f7f7] p-3 font-mono text-xs leading-5">
        {children}
      </pre>
    );
  },
  code({ className, children }) {
    const match = /language-([a-z0-9_-]+)/i.exec(className ?? "");
    const language = match?.[1];

    if (language) {
      return (
        <code className={`${className ?? ""} block whitespace-pre`}>
          <span className="mb-2 block border-b border-[#808080] pb-1 font-sans text-[10px] font-black uppercase text-[#000080]">
            {language}
          </span>
          {children}
        </code>
      );
    }

    return <code className="bg-[#e8e8e8] px-1 font-mono text-[0.92em]">{children}</code>;
  },
  hr() {
    return <hr className="my-5 border-0 border-t-2 border-t-[#808080] border-b-2 border-b-white" />;
  },
  input(props) {
    if (props.type === "checkbox") {
      return (
        <input
          checked={Boolean(props.checked)}
          className="mr-2 inline-block h-3 w-3 align-middle accent-[#000080]"
          readOnly
          type="checkbox"
        />
      );
    }

    return <input {...props} />;
  },
};

function WikiMarkdownPreview({ content }: { content: string }) {
  return (
    <article className="wiki-markdown max-w-5xl text-sm leading-6 text-black">
      <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
        {renderableWikiMarkdown(content)}
      </ReactMarkdown>
    </article>
  );
}

function renderableWikiMarkdown(content: string): string {
  const lines = content.split("\n");
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) {
        return line;
      }

      return replaceWikiLinksOutsideInlineCode(line);
    })
    .join("\n");
}

function replaceWikiLinksOutsideInlineCode(line: string): string {
  const parts = line.split(/(`+)/);
  let inInlineCode = false;

  return parts
    .map((part) => {
      if (/^`+$/.test(part)) {
        if (part.length % 2 === 1) {
          inInlineCode = !inInlineCode;
        }
        return part;
      }

      return inInlineCode ? part : replaceWikiLinks(part);
    })
    .join("");
}

function replaceWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]\n]{1,160})\]\]/g, (_match, rawLink: string) => {
    const [rawTarget, rawLabel] = rawLink.split("|", 2);
    const target = rawTarget.trim();
    if (!target) {
      return _match;
    }

    const label = escapeMarkdownLinkLabel((rawLabel ?? target).trim() || target);
    const slug = encodeURIComponent(slugFromTitle(target));

    return `[${label}](/wiki#${slug})`;
  });
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, "\\$1");
}

export function WikiEditorSplit({
  page,
  draftContent,
  mode,
  callouts,
  onDraftChange,
}: WikiEditorSplitProps) {
  const isEditing = mode === "edit";

  return (
    <section className="flex min-h-0 flex-1 flex-col border-2 border-l-[#404040] border-t-[#404040] border-r-white border-b-white bg-white">
      <div className="flex min-h-8 items-center justify-between border-b border-[#808080] bg-[#dcdcdc] px-2 py-1 text-sm font-bold">
        <span>{isEditing ? "Edit memory source" : "Preview article"}</span>
        <span className="truncate text-xs font-normal">
          {isEditing ? `Markdown / ${page.slug}` : `${page.linkedPrs.length} linked PRs`}
        </span>
      </div>
      {isEditing ? (
        <textarea
          value={draftContent}
          onChange={(event) => onDraftChange(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-white p-3 font-mono text-sm leading-6 text-black outline-none"
          aria-label={`Edit ${page.title}`}
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-auto p-4">
          {callouts.length > 0 ? (
            <div className="mb-4 grid gap-2">
              {callouts.map((callout) => (
                <MemoryCallout key={callout.id} callout={callout} />
              ))}
            </div>
          ) : null}
          <WikiMarkdownPreview content={draftContent} />
        </div>
      )}
    </section>
  );
}
