import {
  demoBacklinks,
  demoRevisions,
} from "./placeholderData";
import type {
  WikiBacklink,
  WikiMemoryCallout,
  WikiPage,
  WikiPageNode,
  WikiPageState,
  WikiRevision,
} from "./types";

const API_ROOT = "/api/v1";
const MAX_SUMMARY_CHARS = 150;
const MAX_BACKLINKS = 12;
const MAX_LINK_SCAN_CHARS = 24000;

export type WikiDataSource = "backend" | "demo" | "local";

export interface WikiMemoryLoad {
  pages: WikiPage[];
  tree: WikiPageNode[];
  callouts: WikiMemoryCallout[];
  source: WikiDataSource;
  message: string;
}

export interface WikiPageContextLoad {
  backlinks: WikiBacklink[];
  revisions: WikiRevision[];
  source: WikiDataSource;
  message: string;
}

export interface WikiSaveResult {
  page: WikiPage;
  source: WikiDataSource;
  message: string;
  revision?: WikiRevision;
}

type BackendWikiPage = {
  id: string;
  space_id?: string;
  slug: string;
  title: string;
  body_markdown: string;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
};

type BackendWikiRevision = {
  id: string;
  page_id: string;
  body_markdown: string;
  author_kind?: string;
  author_id?: string;
  run_id?: string | null;
  change_summary?: string;
  created_at?: string;
};

type JsonRecord = Record<string, unknown>;

type RouteError = Error & { status?: number };

function routeError(status: number, path: string): RouteError {
  const error = new Error(`Wiki API request failed: ${path} (${status})`) as RouteError;
  error.status = status;
  return error;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");

  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    throw routeError(response.status, path);
  }

  return (await response.json()) as T;
}

function copyDemoBacklinks(): WikiBacklink[] {
  return demoBacklinks.map((backlink) => ({ ...backlink }));
}

function copyDemoRevisions(): WikiRevision[] {
  return demoRevisions.map((revision) => ({ ...revision }));
}

function emptyLoad(message: string): WikiMemoryLoad {
  return {
    pages: [],
    tree: [],
    callouts: [],
    source: "local",
    message,
  };
}

export function slugFromTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "untitled";
}

export function titleFromMarkdown(content: string, fallback: string): string {
  const lines = content.split("\n", 80);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      const title = trimmed.slice(2).replace(/\s+/g, " ").trim();
      return title.slice(0, 90) || fallback;
    }
  }

  return fallback;
}

function cleanMarkdownLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/`{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeMarkdown(content: string, fallback: string): string {
  const lines = content.split("\n", 120);
  let inCodeFence = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const summary = cleanMarkdownLine(line);
    if (summary && !summary.startsWith("[!")) {
      return summary.length > MAX_SUMMARY_CHARS
        ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1).trim()}...`
        : summary;
    }
  }

  return fallback;
}

function inferTags(title: string, content: string): string[] {
  const haystack = `${title} ${content.slice(0, 5000)}`.toLowerCase();
  const tags: string[] = [];
  const checks: Array<[string, string]> = [
    ["architecture", "architecture"],
    ["runbook", "runbook"],
    ["github", "github"],
    ["review", "reviews"],
    ["deploy", "deployment"],
    ["agent", "agents"],
    ["prompt", "prompts"],
    ["decision", "decisions"],
  ];

  for (const [needle, tag] of checks) {
    if (haystack.includes(needle) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags.length ? tags.slice(0, 4) : ["memory"];
}

function extractLinkedPrs(content: string): string[] {
  const prs: string[] = [];
  const pattern = /\b(?:PR\s*)?#(\d{1,6})\b/gi;
  const scannedContent = content.slice(0, 8000);
  let match = pattern.exec(scannedContent);

  while (match && prs.length < 6) {
    const pr = `#${match[1]}`;
    if (!prs.includes(pr)) {
      prs.push(pr);
    }
    match = pattern.exec(scannedContent);
  }

  return prs;
}

function estimateMemoryScore(content: string): number {
  const chars = content.trim().length;
  const headingCount = (content.match(/^#{1,3}\s+/gm) ?? []).length;
  const linkCount = (content.match(/\[\[[^\]]+\]\]/g) ?? []).length;
  const hasRunbookShape = content.includes("##") && content.includes("- ");
  const score = 42 + Math.min(24, Math.floor(chars / 180)) + Math.min(18, headingCount * 4) + Math.min(12, linkCount * 3) + (hasRunbookShape ? 8 : 0);

  return Math.max(30, Math.min(96, score));
}

function formatDateLabel(value?: string): string {
  if (!value) return "Unknown";

  const dateValue = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(dateValue.endsWith("Z") ? dateValue : `${dateValue}Z`);
  if (Number.isNaN(date.getTime())) return value;

  const now = new Date();
  const ageMs = now.getTime() - date.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (ageMs >= 0 && ageMs < dayMs) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  if (ageMs >= dayMs && ageMs < 2 * dayMs) {
    return "Yesterday";
  }

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function reviewStateForPage(content: string, updatedAt?: string): WikiPageState {
  if (content.trim().length < 120) return "needs-review";
  if (!updatedAt) return "fresh";

  const dateValue = updatedAt.includes("T") ? updatedAt : updatedAt.replace(" ", "T");
  const date = new Date(dateValue.endsWith("Z") ? dateValue : `${dateValue}Z`);
  if (Number.isNaN(date.getTime())) return "fresh";

  const ageDays = (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000);
  if (ageDays > 21) return "stale";
  if (ageDays < 2) return "fresh";
  return "canonical";
}

function actorLabel(value?: string): string {
  if (!value) return "system";
  if (value === "human") return "You";
  return value;
}

function pagePath(page: BackendWikiPage, title: string): string {
  const space = page.space_id?.replace(/^space_/, "").replace(/_/g, " ") || "project memory";
  return `Memory / ${space} / ${title}`;
}

function mapBackendPage(page: BackendWikiPage): WikiPage {
  const content = page.body_markdown ?? "";
  const title = page.title || titleFromMarkdown(content, "Untitled");

  return {
    id: page.id || page.slug || slugFromTitle(title),
    title,
    slug: page.slug || slugFromTitle(title),
    path: pagePath(page, title),
    summary: summarizeMarkdown(content, `${title} wiki memory page.`),
    content,
    tags: inferTags(title, content),
    ownerAgent: actorLabel(page.created_by || page.updated_by),
    updatedBy: actorLabel(page.updated_by),
    updatedAt: formatDateLabel(page.updated_at || page.created_at),
    reviewState: reviewStateForPage(content, page.updated_at || page.created_at),
    linkedPrs: extractLinkedPrs(content),
    memoryScore: estimateMemoryScore(content),
  };
}

export function pageToTreeNode(page: WikiPage): WikiPageNode {
  return {
    id: page.id,
    title: page.title,
    slug: page.slug,
    icon: page.tags.includes("runbook") ? "RUN" : page.tags.includes("github") ? "GH" : "DOC",
    state: page.reviewState,
    updatedBy: page.updatedBy,
    updatedAt: page.updatedAt,
    summary: page.summary,
  };
}

function bucketForPage(page: WikiPage): { id: string; title: string; icon: string } {
  const tags = page.tags.join(" ");
  const text = `${page.title} ${page.summary}`.toLowerCase();

  if (tags.includes("runbook") || text.includes("runbook")) {
    return { id: "runbooks-root", title: "Runbooks", icon: "RUN" };
  }

  if (tags.includes("github") || tags.includes("reviews") || text.includes("review")) {
    return { id: "engineering-root", title: "Engineering", icon: "ENG" };
  }

  if (tags.includes("architecture") || text.includes("architecture")) {
    return { id: "architecture-root", title: "Architecture", icon: "ARCH" };
  }

  return { id: "mission-memory-root", title: "Mission Memory", icon: "KB" };
}

export function buildWikiTree(pages: WikiPage[]): WikiPageNode[] {
  const buckets: WikiPageNode[] = [];

  for (const page of pages) {
    const bucket = bucketForPage(page);
    let node = buckets.find((candidate) => candidate.id === bucket.id);

    if (!node) {
      node = {
        id: bucket.id,
        title: bucket.title,
        slug: slugFromTitle(bucket.title),
        icon: bucket.icon,
        state: "canonical",
        updatedBy: "system",
        updatedAt: "Now",
        summary: `${bucket.title} wiki memory pages.`,
        children: [],
      };
      buckets.push(node);
    }

    node.children?.push(pageToTreeNode(page));
  }

  return buckets.map((bucket) => {
    const children = bucket.children ?? [];
    const freshest = children[0];
    return {
      ...bucket,
      state: children.some((child) => child.state === "needs-review") ? "needs-review" : bucket.state,
      updatedBy: freshest?.updatedBy ?? bucket.updatedBy,
      updatedAt: freshest?.updatedAt ?? bucket.updatedAt,
      children,
    };
  });
}

export async function loadWikiMemory(): Promise<WikiMemoryLoad> {
  try {
    const backendPages = await fetchJson<BackendWikiPage[]>(`${API_ROOT}/wiki/pages`);
    if (!backendPages.length) {
      return emptyLoad("Backend wiki has no pages yet. Create a page to seed shared memory.");
    }

    const pages = backendPages.map(mapBackendPage);
    return {
      pages,
      tree: buildWikiTree(pages),
      callouts: [],
      source: "backend",
      message: `Loaded ${pages.length} wiki page${pages.length === 1 ? "" : "s"} from backend.`,
    };
  } catch {
    return emptyLoad("Backend wiki unavailable. Start the backend to load shared memory.");
  }
}

function mapRevision(revision: BackendWikiRevision): WikiRevision {
  const summary = revision.change_summary?.trim() || "Saved wiki memory revision.";
  const tokenDelta = Math.max(1, Math.round((revision.body_markdown ?? "").length / 4));

  return {
    id: revision.id,
    label: summary.length > 42 ? `${summary.slice(0, 41).trim()}...` : summary,
    author: actorLabel(revision.author_id || revision.author_kind),
    createdAt: formatDateLabel(revision.created_at),
    summary,
    tokenDelta,
  };
}

function readString(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function normalizeSourceType(value: string): WikiBacklink["sourceType"] {
  if (value === "channel" || value === "dm" || value === "pr" || value === "wiki") {
    return value;
  }
  return "wiki";
}

function mapBacklink(record: JsonRecord, index: number, pages: WikiPage[]): WikiBacklink {
  const sourcePageId = readString(record, "source_page_id");
  const sourceSlug = readString(record, "source_slug");
  const sourcePage = pages.find((page) => page.id === sourcePageId || page.slug === sourceSlug);
  const linkText = readString(record, "link_text") || readString(record, "target_slug");
  const title = readString(record, "title") || `[[${linkText || "memory"}]] reference`;

  return {
    id: readString(record, "id") || `${sourcePageId || sourceSlug || "backlink"}-${index}`,
    title,
    sourceType: normalizeSourceType(readString(record, "source_type")),
    sourceLabel: readString(record, "source_label") || sourcePage?.title || "Wiki page",
    excerpt: readString(record, "excerpt") || sourcePage?.summary || "This source links to the current wiki page.",
    agent: actorLabel(readString(record, "agent") || sourcePage?.updatedBy),
    timestamp: formatDateLabel(readString(record, "created_at") || readString(record, "updated_at")),
  };
}

function wikiLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[\[([^\]\n]{1,120})\]\]/g;
  const scannedContent = content.slice(0, MAX_LINK_SCAN_CHARS);
  let match = pattern.exec(scannedContent);

  while (match && links.length < 80) {
    links.push(match[1].trim());
    match = pattern.exec(scannedContent);
  }

  return links;
}

function lineExcerpt(content: string, alias: string): string {
  const lowerAlias = alias.toLowerCase();
  const lines = content.split("\n", 220);

  for (const line of lines) {
    if (line.toLowerCase().includes(lowerAlias)) {
      const excerpt = cleanMarkdownLine(line);
      if (excerpt) {
        return excerpt.length > MAX_SUMMARY_CHARS
          ? `${excerpt.slice(0, MAX_SUMMARY_CHARS - 1).trim()}...`
          : excerpt;
      }
    }
  }

  return "This page links to the current memory page.";
}

function deriveBacklinks(page: WikiPage, pages: WikiPage[]): WikiBacklink[] {
  const aliases = new Set([page.slug.toLowerCase(), page.title.toLowerCase(), slugFromTitle(page.title)]);
  const backlinks: WikiBacklink[] = [];

  for (const sourcePage of pages) {
    if (sourcePage.id === page.id) continue;

    const matchedLink = wikiLinks(sourcePage.content).find((link) => {
      const normalized = link.toLowerCase();
      return aliases.has(normalized) || aliases.has(slugFromTitle(normalized));
    });

    if (!matchedLink) continue;

    backlinks.push({
      id: `derived-${sourcePage.id}-${page.id}`,
      title: `${sourcePage.title} links to ${page.title}`,
      sourceType: "wiki",
      sourceLabel: sourcePage.title,
      excerpt: lineExcerpt(sourcePage.content, matchedLink),
      agent: sourcePage.updatedBy,
      timestamp: sourcePage.updatedAt,
    });

    if (backlinks.length >= MAX_BACKLINKS) break;
  }

  return backlinks;
}

function revisionFromPage(page: WikiPage): WikiRevision {
  return {
    id: `current-${page.id}`,
    label: `Current ${page.title}`,
    author: page.updatedBy,
    createdAt: page.updatedAt,
    summary: page.summary,
    tokenDelta: Math.max(1, Math.round(page.content.length / 4)),
  };
}

export async function loadWikiPageContext(
  page: WikiPage,
  pages: WikiPage[],
  source: WikiDataSource,
): Promise<WikiPageContextLoad> {
  if (source === "demo") {
    return {
      backlinks: copyDemoBacklinks(),
      revisions: copyDemoRevisions(),
      source: "demo",
      message: "Demo backlinks and revisions loaded.",
    };
  }

  const revisionsRequest = fetchJson<BackendWikiRevision[]>(
    `${API_ROOT}/wiki/pages/${encodeURIComponent(page.slug)}/revisions`,
  );
  // Worker 1 integration assumption: backlinks will hang off the page slug.
  const backlinksRequest = fetchJson<JsonRecord[]>(
    `${API_ROOT}/wiki/pages/${encodeURIComponent(page.slug)}/backlinks`,
  );

  const [revisionResult, backlinkResult] = await Promise.allSettled([revisionsRequest, backlinksRequest]);
  const revisions =
    revisionResult.status === "fulfilled" && revisionResult.value.length
      ? revisionResult.value.map(mapRevision)
      : [revisionFromPage(page)];
  const backlinks =
    backlinkResult.status === "fulfilled"
      ? backlinkResult.value.map((record, index) => mapBacklink(record, index, pages))
      : deriveBacklinks(page, pages);
  const message =
    backlinkResult.status === "fulfilled"
      ? "Loaded revisions and backlinks from backend."
      : "Loaded revisions; derived backlinks locally until backend backlink route is ready.";

  return {
    backlinks,
    revisions,
    source: backlinkResult.status === "fulfilled" && revisionResult.status === "fulfilled" ? "backend" : "local",
    message,
  };
}

function isUnsavedLocalPage(page: WikiPage): boolean {
  return page.updatedAt === "Not saved" || page.id.startsWith("new-memory-page-");
}

function localSavedPage(page: WikiPage, content: string): WikiPage {
  const title = titleFromMarkdown(content, page.title);
  const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return {
    ...page,
    title,
    slug: isUnsavedLocalPage(page) ? slugFromTitle(title) : page.slug,
    path: isUnsavedLocalPage(page) ? `Memory / Inbox / ${title}` : page.path,
    summary: summarizeMarkdown(content, `${title} wiki memory page.`),
    content,
    tags: inferTags(title, content),
    updatedBy: "You",
    updatedAt: now,
    reviewState: page.reviewState === "canonical" ? "canonical" : "fresh",
    linkedPrs: extractLinkedPrs(content),
    memoryScore: Math.max(page.memoryScore, estimateMemoryScore(content)),
  };
}

function saveRevision(page: WikiPage, content: string, message: string): WikiRevision {
  return {
    id: `rev-local-${Date.now()}`,
    label: `Saved ${page.title}`,
    author: "You",
    createdAt: page.updatedAt,
    summary: message,
    tokenDelta: Math.max(1, Math.round(content.length / 4)),
  };
}

function isMissingEndpoint(error: unknown): boolean {
  const route = error as RouteError;
  return route.status === 404 || route.status === 405 || route.status === 501;
}

function failedSave(message: string, cause?: unknown): Error {
  const error = new Error(message);
  return Object.assign(error, { cause });
}

async function updateExistingPage(page: WikiPage, payload: JsonRecord): Promise<BackendWikiPage> {
  const path = `${API_ROOT}/wiki/pages/${encodeURIComponent(page.slug)}`;

  try {
    // Worker 1 integration assumption: updates accept the same payload shape as page create.
    return await fetchJson<BackendWikiPage>(path, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (!isMissingEndpoint(error)) throw error;

    return await fetchJson<BackendWikiPage>(path, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
}

export async function saveWikiPageDraft(page: WikiPage, content: string): Promise<WikiSaveResult> {
  const localPage = localSavedPage(page, content);
  const changeSummary = isUnsavedLocalPage(page) ? "Created page from wiki editor." : "Updated page from wiki editor.";
  const payload: JsonRecord = {
    title: localPage.title,
    body_markdown: content,
    updated_by: "human",
    change_summary: changeSummary,
  };

  if (isUnsavedLocalPage(page)) {
    try {
      const createdPage = await fetchJson<BackendWikiPage>(`${API_ROOT}/wiki/pages`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const savedPage = mapBackendPage(createdPage);
      return {
        page: savedPage,
        source: "backend",
        message: "Saved new page to backend.",
        revision: saveRevision(savedPage, content, changeSummary),
      };
    } catch {
      throw failedSave("Backend save failed; draft remains unsaved.");
    }
  }

  try {
    const updatedPage = await updateExistingPage(page, payload);
    const savedPage = mapBackendPage(updatedPage);
    return {
      page: savedPage,
      source: "backend",
      message: "Saved page to backend.",
      revision: saveRevision(savedPage, content, changeSummary),
    };
  } catch (error) {
    const message = isMissingEndpoint(error)
      ? "Backend update endpoint is unavailable; draft remains unsaved."
      : "Backend update failed; draft remains unsaved.";

    throw failedSave(message, error);
  }
}
