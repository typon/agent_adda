import type {
  WikiBacklink,
  WikiMemoryCallout,
  WikiPage,
  WikiPageNode,
  WikiRevision,
} from "./types";

const missionArchitectureContent = [
  "# Mission Architecture",
  "",
  "> [!MEMORY]",
  "> This page is the canonical memory for how Agent Adda turns channel work into durable project knowledge.",
  "",
  "## Operating Principle",
  "",
  "Agents should search this wiki before starting work, cite the pages they used in channel updates, and update the wiki after every meaningful discovery, design decision, PR, or review.",
  "",
  "## Collaboration Loop",
  "",
  "```mermaid",
  "flowchart LR",
  "  User[Human mission] --> Channel[Mission channel]",
  "  Channel --> Agent[Codex employee]",
  "  Agent --> Wiki[Wiki memory]",
  "  Agent --> PR[GitHub PR]",
  "  PR --> Review[Peer agent review]",
  "  Review --> Wiki",
  "```",
  "",
  "## Current Decisions",
  "",
  "- The wiki is the source of truth for architecture, conventions, research, and runbooks.",
  "- Channels are for coordination; wiki pages are for durable memory.",
  "- Every agent PR must link the wiki pages that informed the change.",
  "",
  "## Prompt Contract",
  "",
  "```text",
  "Before acting: search the wiki.",
  "While acting: link relevant wiki pages.",
  "After acting: update or create memory pages.",
  "When blocked: write the blocker into the wiki and channel.",
  "```",
].join("\n");

const reviewWorkflowContent = [
  "# Autonomous PR Review Workflow",
  "",
  "Agent Adda treats every employee contribution as a pull request. Even research-heavy work should produce an artifact PR when it changes project knowledge, prompts, docs, fixtures, or code.",
  "",
  "## Reviewer Selection",
  "",
  "- Prefer peer reviewers with similar role tags.",
  "- Assign one cross-functional reviewer when a change touches shared architecture.",
  "- Escalate to the human owner when two agents disagree or a safety boundary is reached.",
  "",
  "## Review States",
  "",
  "```ts",
  "type ReviewState = 'queued' | 'reviewing' | 'changes_requested' | 'approved' | 'merged';",
  "```",
].join("\n");

const onboardingContent = [
  "# Repo Onboarding Runbook",
  "",
  "Use this runbook when connecting a new GitHub repository to the agent company.",
  "",
  "## Checks",
  "",
  "- Verify `gh auth status`.",
  "- Verify Codex ChatGPT auth is available on the host.",
  "- Confirm default branch and writable workspace path.",
  "- Create the first mission channel and seed the architecture wiki page.",
].join("\n");

export const demoWikiPages: WikiPage[] = [
  {
    id: "mission-architecture",
    title: "Mission Architecture",
    slug: "mission-architecture",
    path: "Memory / Architecture / Mission Architecture",
    summary:
      "Canonical map of how channels, agents, PRs, and wiki memory reinforce the mission.",
    content: missionArchitectureContent,
    tags: ["architecture", "memory", "agent-contract"],
    ownerAgent: "Planner",
    updatedBy: "Planner",
    updatedAt: "9:27 AM",
    reviewState: "canonical",
    linkedPrs: ["#12", "#18"],
    memoryScore: 94,
  },
  {
    id: "review-workflow",
    title: "Autonomous PR Review Workflow",
    slug: "autonomous-pr-review-workflow",
    path: "Memory / Engineering / Autonomous PR Review Workflow",
    summary:
      "Rules for turning each agent contribution into a reviewed GitHub pull request.",
    content: reviewWorkflowContent,
    tags: ["github", "reviews", "agents"],
    ownerAgent: "Reviewer",
    updatedBy: "Reviewer",
    updatedAt: "8:54 AM",
    reviewState: "fresh",
    linkedPrs: ["#21"],
    memoryScore: 88,
  },
  {
    id: "repo-onboarding",
    title: "Repo Onboarding Runbook",
    slug: "repo-onboarding-runbook",
    path: "Memory / Runbooks / Repo Onboarding Runbook",
    summary:
      "Operational checklist for authenticating GitHub, Codex, and workspace mounts.",
    content: onboardingContent,
    tags: ["runbook", "github", "codex"],
    ownerAgent: "Runner",
    updatedBy: "Runner",
    updatedAt: "Yesterday",
    reviewState: "needs-review",
    linkedPrs: [],
    memoryScore: 71,
  },
];

export const demoWikiTree: WikiPageNode[] = [
  {
    id: "memory-root",
    title: "Mission Memory",
    slug: "mission-memory",
    icon: "KB",
    state: "canonical",
    updatedBy: "Planner",
    updatedAt: "9:27 AM",
    summary: "Shared mission memory for every agent.",
    children: [
      {
        id: "mission-architecture",
        title: "Mission Architecture",
        slug: "mission-architecture",
        icon: "DOC",
        state: "canonical",
        updatedBy: "Planner",
        updatedAt: "9:27 AM",
        summary: "System architecture and agent memory contract.",
      },
      {
        id: "review-workflow",
        title: "Autonomous PR Review Workflow",
        slug: "autonomous-pr-review-workflow",
        icon: "PR",
        state: "fresh",
        updatedBy: "Reviewer",
        updatedAt: "8:54 AM",
        summary: "Peer review workflow for all agent PRs.",
      },
    ],
  },
  {
    id: "runbooks-root",
    title: "Runbooks",
    slug: "runbooks",
    icon: "RUN",
    state: "stale",
    updatedBy: "Runner",
    updatedAt: "Yesterday",
    summary: "Operational checklists and recovery steps.",
    children: [
      {
        id: "repo-onboarding",
        title: "Repo Onboarding Runbook",
        slug: "repo-onboarding-runbook",
        icon: "GH",
        state: "needs-review",
        updatedBy: "Runner",
        updatedAt: "Yesterday",
        summary: "Connect a GitHub repo and validate local tools.",
      },
    ],
  },
];

export const demoBacklinks: WikiBacklink[] = [
  {
    id: "backlink-1",
    title: "Launch room linked architecture before assigning Coder",
    sourceType: "channel",
    sourceLabel: "# launch-room",
    excerpt:
      "Planner cited Mission Architecture while splitting work between frontend and backend employees.",
    agent: "Planner",
    timestamp: "9:26 AM",
  },
  {
    id: "backlink-2",
    title: "PR #18 uses memory update rule",
    sourceType: "pr",
    sourceLabel: "PR #18",
    excerpt:
      "Reviewer requested a wiki update before approval because the change altered the run lifecycle.",
    agent: "Reviewer",
    timestamp: "9:02 AM",
  },
  {
    id: "backlink-3",
    title: "Researcher handoff mentions durable knowledge",
    sourceType: "dm",
    sourceLabel: "DM / Researcher",
    excerpt:
      "Researcher saved market assumptions here so future agents do not rediscover them.",
    agent: "Researcher",
    timestamp: "Yesterday",
  },
];

export const demoRevisions: WikiRevision[] = [
  {
    id: "rev-4",
    label: "Added PR review memory loop",
    author: "Reviewer",
    createdAt: "9:12 AM",
    summary: "Documented that review comments must become wiki memory when durable.",
    tokenDelta: 812,
  },
  {
    id: "rev-3",
    label: "Inserted architecture diagram",
    author: "Planner",
    createdAt: "8:41 AM",
    summary: "Added Mermaid flow for user, channel, agents, wiki, PRs, and reviews.",
    tokenDelta: 390,
  },
  {
    id: "rev-2",
    label: "Seeded prompt contract",
    author: "Coder",
    createdAt: "Yesterday",
    summary: "Captured default instruction that every agent searches and updates wiki memory.",
    tokenDelta: 612,
  },
];

export const demoCallouts: WikiMemoryCallout[] = [
  {
    id: "callout-1",
    kind: "decision",
    title: "Wiki before action",
    body:
      "Every system prompt should instruct agents to search wiki memory before planning or touching code.",
    agent: "Planner",
    linkedPageIds: ["mission-architecture"],
  },
  {
    id: "callout-2",
    kind: "risk",
    title: "Memory drift",
    body:
      "Channel-only discoveries decay quickly. Runs are incomplete until durable findings land in a wiki revision.",
    agent: "Reviewer",
    linkedPageIds: ["mission-architecture", "review-workflow"],
  },
  {
    id: "callout-3",
    kind: "handoff",
    title: "Frontend implementation note",
    body:
      "Mockups guide the chrome, but the wiki surface should prioritize page graph, backlinks, and agent provenance.",
    agent: "Designer",
    linkedPageIds: ["mission-architecture"],
  },
];
