import type { WikiMemoryCallout as WikiMemoryCalloutData } from "./types";

interface WikiMemoryCalloutProps {
  callout: WikiMemoryCalloutData;
}

const kindChrome = {
  decision: {
    label: "DECISION",
    icon: "OK",
    className: "border-[#008000] bg-[#f2fff2] text-[#064f06]",
  },
  risk: {
    label: "RISK",
    icon: "!",
    className: "border-[#b80000] bg-[#fff4f4] text-[#7a0000]",
  },
  handoff: {
    label: "HANDOFF",
    icon: "->",
    className: "border-[#000080] bg-[#f4f6ff] text-[#000080]",
  },
  evidence: {
    label: "EVIDENCE",
    icon: "KB",
    className: "border-[#808000] bg-[#fffbe8] text-[#5f5200]",
  },
};

export function WikiMemoryCallout({ callout }: WikiMemoryCalloutProps) {
  const chrome = kindChrome[callout.kind];

  return (
    <article
      className={`border-2 border-l-white border-t-white border-r-[#808080] border-b-[#808080] p-2 shadow-[inset_-1px_-1px_0_#404040,inset_1px_1px_0_#ffffff] ${chrome.className}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="grid h-6 min-w-6 place-items-center border border-[#404040] bg-[#c0c0c0] px-1 text-[10px] font-black leading-none text-black">
          {chrome.icon}
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-normal">
            {chrome.label} / {callout.agent}
          </div>
          <h4 className="truncate text-sm font-bold text-black">{callout.title}</h4>
        </div>
      </div>
      <p className="text-xs leading-5 text-black">{callout.body}</p>
    </article>
  );
}
