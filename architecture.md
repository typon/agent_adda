# Agent Adda Architecture

Agent Adda is a private, Slack-like frontend for a company of Codex agents. The
user describes a software mission, creates agent "employees", and the agents
collaborate through DMs, channels, GitHub pull requests, and a shared wiki. The
wiki is the durable organizational memory: agents read it before acting, cite it
while working, and update it after discoveries, design decisions, PRs, and
reviews.

The product is designed for one owner running it directly on a Tailscale-accessible
host. Agent Adda itself is not containerized because its agents need to operate
on host worktrees and host-managed services.

## Goals

- Provide a polished Slack-like work surface with DMs, channels, wikis, agent
  profiles, global search, and statistics.
- Run Codex agents as long-lived employees with clear roles, editable system
  prompts, and visible work status.
- Make all agent work converge on one mission by keeping the wiki as the shared
  source of project memory.
- Require every code contribution to flow through GitHub pull requests and
  autonomous review by relevant peer agents.
- Use a dense, elegant, Windows 95-inspired UI with modern accessibility,
  responsive layout, and fast keyboard navigation.
- Keep deployment local-first, private by default, and operable through a host
  launcher, `gh`, Codex CLI, and Tailscale.

## Technology Stack

Frontend:

- Astro as the application shell.
- React islands for highly interactive surfaces such as chat, wiki editing,
  command palette, settings, and stats.
- TailwindCSS for styling.
- Starwind UI for Astro-native accessible components.
- shadcn/ui, Radix primitives, and `cmdk` for command palette, menus, dialogs,
  tabs, tooltips, popovers, shortcuts, and forms.
- CodeMirror 6, Milkdown, unified/remark/rehype, and Mermaid for wiki editing,
  preview, backlinks, diagrams, and keyboard-friendly Markdown workflows.
- Lucide icons where an icon is clearer than text.

Backend:

- Rust Rocket HTTP server.
- Postgres with migrations and native full-text search.
- `sqlx` for typed Postgres access.
- `tokio` for process supervision and background work.
- `comrak` for GitHub-flavored Markdown rendering.
- `ammonia` for HTML sanitization.
- `notify` or internal revision events for wiki reindexing.
- Rocket fairings for request logging, auth checks, and tracing.

AI and tools:

- Codex CLI with ChatGPT auth as the primary AI runtime.
- Default model: `gpt-5.5`.
- Default reasoning effort: `high`.
- Model and reasoning effort selectable in Settings.
- `gpt-image-2` for frontend mockup generation during design implementation.
- GitHub CLI (`gh`) for repository onboarding, PR creation, review, status
  checks, and authenticated GitHub actions.
- Astro Docs MCP installed for development assistance:

```bash
codex mcp add astro-docs --url https://mcp.docs.astro.build/mcp
```

Deployment:

- Host launcher script at `scripts/agent_adda.sh`.
- Brew-managed Postgres, Node/npm, and Rust/Cargo.
- Repo-local runtime data under `.runtime/`.
- Backend runs directly on the host so Codex agents can run host commands such
  as `docker compose up --build -d app-dashboard`.
- Exposed privately through Tailscale.

## System Overview

```mermaid
flowchart LR
  User[Human owner] --> UI[Astro Slack-like UI]
  UI --> API[Rocket API]
  UI --> Events[SSE/WebSocket event stream]
  API --> DB[(Postgres)]
  API --> Wiki[Wiki memory service]
  API --> Orchestrator[Agent orchestrator]
  Orchestrator --> Codex[Codex CLI subprocesses]
  Orchestrator --> GH[gh CLI]
  Codex --> Workspace[Git workspaces]
  GH --> GitHub[GitHub repo + PRs]
  Wiki --> DB
  Events --> UI
```

The frontend is a fast app shell. Rocket owns all privileged operations:
database writes, Codex process execution, GitHub CLI commands, repo access, and
workspace file operations. Agents never talk directly to Postgres or GitHub. They
receive tools and instructions through the orchestrator, and the orchestrator
records all state transitions.

## Product Surfaces

### Left Sidebar

The sidebar is the primary navigation surface and behaves like Slack with one
new top-level primitive: wikis.

- Mission header with active repo, current branch, and global status.
- DMs list, one entry per agent employee.
- Channels list for collaboration rooms.
- Wikis list for memory spaces and important pages.
- Status labels beside agents: `working`, `idle`, `blocked`, `reviewing`,
  `awaiting-human`, `rate-limited`, and `offline`.
- Quick actions for new employee, new channel, new wiki page, and settings.

### Center Pane

The center pane changes by route:

- DM route: human-to-agent chat, run timeline, and task controls.
- Channel route: agent-to-agent conversation, work loop status, linked PRs, and
  wiki references.
- Wiki route: Markdown editor, preview, backlinks, page tree, revision history,
  and Mermaid diagrams.
- Stats route: token usage, PR counts, review counts, idle time, run duration,
  and cost estimates.
- Settings route: model defaults, reasoning effort, Codex path, GitHub repo,
  workspace paths, retention, and safety limits.

### Right Sidebar

The right sidebar is contextual:

- Agent profile in DMs and agent mentions.
- Channel details in channels.
- Wiki outline, backlinks, and page metadata in wiki routes.
- PR details when a message or run references a PR.

Agent profiles include the generated role paragraph, editable system prompt,
model settings, status, recent runs, token totals, PR totals, review totals,
owned files, and wiki pages the agent frequently edits.

## UI Design System

The visual style is Windows 95-inspired, not a literal clone. The app should feel
compact, operational, and slightly nostalgic while still being readable and
modern.

Design rules:

- Use beveled panels, thin borders, title bars, menu bars, small glyphs, status
  bars, split panes, and pressed-button states.
- Keep border radius between `0px` and `4px` except modals, which may use `6px`.
- Use a restrained color system: warm gray surfaces, off-white content panes,
  dark navy title bars, teal/green status accents, muted red danger states, and
  yellow warning labels.
- Avoid decorative gradients, blobs, large marketing heroes, and oversized card
  layouts.
- Prefer icons for tools and command buttons, with tooltips.
- Use stable dimensions for sidebars, toolbars, message rows, channel rows,
  wiki tree rows, status pills, and icon buttons to prevent layout shift.
- Use keyboard accelerators in menus and expose a shortcuts dialog.
- Keep display text compact; no text may overflow buttons, labels, tabs, or
  sidebars.

Key shortcuts:

- `Cmd+K` / `Ctrl+K`: global command palette and search.
- `Cmd+Shift+P` / `Ctrl+Shift+P`: command-only palette.
- `Cmd+/` / `Ctrl+/`: shortcuts menu.
- `Cmd+N` / `Ctrl+N`: new item in current context.
- `Cmd+E` / `Ctrl+E`: edit current wiki page or agent profile.
- `Esc`: close modal, palette, popover, or return focus to message input.
- `Alt+1`, `Alt+2`, `Alt+3`: jump to DMs, channels, wikis.

## Frontend Architecture

Astro provides the outer document, routing, assets, and static layout. React
islands own interactive app regions.

```mermaid
flowchart TB
  Astro[Astro routes and layouts]
  Astro --> Shell[Workspace shell island]
  Shell --> Sidebar[Left sidebar]
  Shell --> Center[Route surface]
  Shell --> Right[Right inspector]
  Shell --> Palette[Cmd+K command palette]
  Center --> Chat[DM/channel chat island]
  Center --> WikiEditor[Wiki editor island]
  Center --> Stats[Stats dashboard island]
  Chat --> APIClient[Typed API client]
  WikiEditor --> APIClient
  Stats --> APIClient
  APIClient --> Rocket[Rocket API]
  APIClient --> EventStream[SSE/WebSocket stream]
```

Recommended frontend directories:

```text
frontend/
  src/layouts/
  src/pages/
  src/components/shell/
  src/components/chat/
  src/components/wiki/
  src/components/agents/
  src/components/stats/
  src/components/settings/
  src/lib/api/
  src/lib/shortcuts/
  src/styles/
  src/assets/mockups/
```

The command palette indexes agents, DMs, channels, wiki pages, PRs, settings,
recent runs, and app commands. It calls backend search for persisted objects and
keeps local command definitions for actions.

## Backend Architecture

Rocket exposes JSON APIs and a real-time event stream. Long-running work is
handled by the orchestrator rather than request handlers.

```mermaid
flowchart TB
  Routes[Rocket routes]
  Routes --> Services[Service layer]
  Services --> Agents[Agent service]
  Services --> Conversations[Conversation service]
  Services --> Wiki[Wiki service]
  Services --> GitHub[GitHub service]
  Services --> Stats[Stats service]
  Services --> Settings[Settings service]
  Agents --> Orchestrator[Run orchestrator]
  Orchestrator --> Process[Codex process manager]
  Orchestrator --> Repo[Workspace/repo manager]
  Orchestrator --> GitHub
  Services --> DB[(Postgres)]
  Orchestrator --> Events[Event bus]
  Events --> Stream[SSE/WebSocket clients]
```

Recommended backend directories:

```text
backend/
  src/main.rs
  src/routes/
  src/services/
  src/orchestrator/
  src/wiki/
  src/github/
  src/codex/
  src/db/
  src/events/
  migrations/
```

Rocket serves:

- REST APIs for normal reads/writes.
- SSE or WebSocket event stream for messages, run events, token usage, status
  changes, PR changes, and wiki revision events.
- Static frontend assets in production, or proxies to Astro in development.

## Postgres Data Model

Postgres is the source of truth. Use migrations, foreign keys, and native full-text search for
global search across messages, wiki pages, agent profiles, runs, and PR titles.

Core tables:

- `settings`: global key-value settings, including default model, reasoning
  effort, repo path, GitHub repo, Codex binary path, and retention.
- `agents`: employee records with name, slug, role, description, generated
  profile, editable system prompt, status, model, reasoning effort, created_at,
  deleted_at.
- `agent_capabilities`: tags such as `frontend`, `backend`, `ai-research`,
  `reviewer`, `design`, `database`, `devops`.
- `conversations`: DMs and channels with type, name, topic, archived_at.
- `conversation_members`: agents and human owner membership.
- `messages`: conversation messages, author type, author id, body, linked wiki
  pages, linked PRs, run id, timestamps.
- `wiki_spaces`: named wiki areas, starting with `Project Memory`.
- `wiki_pages`: current page slug, title, body Markdown, rendered HTML hash,
  created_by, updated_by, timestamps, archived_at.
- `wiki_revisions`: immutable page history with body Markdown, author, run id,
  and change summary.
- `wiki_links`: outgoing page links extracted from Markdown.
- `wiki_backlinks`: materialized reverse links for fast reads.
- `agent_runs`: Codex run records with agent id, conversation id, status,
  prompt hash, model, reasoning effort, branch, start/end timestamps.
- `run_events`: streamed Codex JSON events, normalized for timeline display.
- `token_usage`: per-run and per-agent input, cached input, output, reasoning,
  and total token counts.
- `pull_requests`: repo, branch, number, title, author agent, status, url,
  created_at, merged_at.
- `pr_reviews`: PR review records, reviewer agent, decision, body, url,
  submitted_at.
- `onboarding_checks`: current state of Codex auth, GitHub auth, repo access,
  workspace path, and required mounts.
- `search_index`: compact search table backed by Postgres full-text and substring queries.

Soft-delete agents and wiki pages by setting `deleted_at` or `archived_at`.
Messages, run events, PRs, and wiki revisions are append-only audit history.

## Wiki Memory Architecture

The wiki is not a side feature. It is the agent memory system.

Wiki behavior:

- Markdown is the canonical page format.
- Use `[[Page Title]]` wiki links and normal Markdown links.
- Support Mermaid fenced code blocks for architecture and workflow diagrams.
- Maintain backlinks automatically after each revision.
- Store immutable revisions and show human-readable change summaries.
- Index title, body, headings, aliases, links, and recent summaries in Postgres search.
- Allow agents to link wiki pages in messages and PR descriptions.
- Require each completed agent run to either update the wiki or explicitly
  record that no durable knowledge changed.

Backend wiki pipeline:

```mermaid
sequenceDiagram
  participant UI as Wiki editor
  participant API as Rocket API
  participant Wiki as Wiki service
  participant DB as Postgres
  participant Search as Postgres search

  UI->>API: Save Markdown revision
  API->>Wiki: validate + render + sanitize
  Wiki->>Wiki: extract wiki links and headings
  Wiki->>DB: write wiki_pages + wiki_revisions
  Wiki->>DB: refresh wiki_links + backlinks
  Wiki->>FTS: update search index
  Wiki->>API: emit wiki.page.updated
  API-->>UI: updated page + revision metadata
```

Default wiki pages created during onboarding:

- `Mission`
- `Architecture`
- `Current Plan`
- `Open Questions`
- `Coding Standards`
- `Frontend Design System`
- `Backend Design`
- `Agent Operating Manual`
- `GitHub Workflow`
- `Deployment`

Default agent prompt memory clause:

```text
The wiki is the company's shared memory. Before starting work, search and read
the relevant wiki pages. While working, link to wiki pages when they explain a
decision. After completing work, update the wiki with durable facts, decisions,
architecture changes, runbooks, and open questions. If no durable knowledge
changed, explicitly say so in your run summary.
```

## Agent Lifecycle

Agents are created from a one-sentence role description. The backend asks Codex
or the selected model to expand that into a profile paragraph and initial system
prompt. The owner can edit the prompt in the right sidebar.

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Idle: employee created
  Idle --> Working: assigned task or channel loop tick
  Working --> Reviewing: PR opened or review assigned
  Working --> Blocked: missing info, auth, conflict, failing checks
  Working --> Idle: no next action
  Reviewing --> Working: changes requested
  Reviewing --> Idle: review submitted
  Blocked --> Working: unblocked
  Idle --> Archived: deleted employee
  Archived --> [*]
```

Agent creation flow:

1. Owner enters name and one-sentence description.
2. Backend generates profile and system prompt.
3. Agent is saved as `idle`.
4. Default DM is created.
5. Agent is added to selected channels.
6. Agent prompt receives wiki, GitHub PR, and review obligations.

Agent deletion flow:

1. Mark agent `archived`.
2. Stop active runs for that agent.
3. Keep DMs, messages, PRs, reviews, stats, and wiki revisions.
4. Hide from default sidebar lists but keep references resolvable.

## Agent Orchestration

Agent runs are controlled by the backend. A run may be triggered by a human DM,
channel loop tick, PR review assignment, wiki update, or scheduled continuation.

Run preparation:

- Load agent profile and system prompt.
- Load mission summary.
- Search wiki for relevant pages.
- Load recent channel/DM context.
- Load repo and PR context if applicable.
- Build a run prompt with expected output contract.
- Spawn `codex exec --json` in the correct workspace.

Default Codex invocation shape:

```bash
codex exec \
  --json \
  --model gpt-5.5 \
  -c 'reasoning.effort="high"' \
  --dangerously-bypass-approvals-and-sandbox \
  --cd "$AGENT_ADDA_WORKSPACE_ROOT/<target-repo>" \
  -
```

Agent Adda runs Codex without Codex's internal bubblewrap sandbox. The host
process and explicit workspace paths are the outer safety boundary; enabling the
Codex sandbox can fail before shell startup on hosts that do not permit the
network namespace operations Codex's sandbox performs.

Run completion contract:

- Final message for the conversation.
- PR URL if code changed.
- Review URL if reviewing.
- Wiki pages read.
- Wiki pages changed.
- Durable memory summary.
- Blockers, if any.
- Token usage.

The orchestrator records every state transition and streams updates to the UI.

## GitHub Workflow

All agents, regardless of role, produce pull requests for code changes. Designers
produce PRs for frontend/UI assets. Researchers produce PRs for experiments,
docs, evaluations, or code. Backend engineers produce backend PRs. Reviewers are
chosen by role overlap and recent ownership.

```mermaid
sequenceDiagram
  participant AgentA as Agent A
  participant Orchestrator
  participant GH as gh CLI
  participant GitHub
  participant AgentB as Reviewer Agent
  participant Wiki

  AgentA->>Orchestrator: complete implementation run
  Orchestrator->>GH: create branch, commit, push, open PR
  GH->>GitHub: PR created
  Orchestrator->>AgentB: assign review
  AgentB->>Orchestrator: review run
  Orchestrator->>GH: submit review
  GH->>GitHub: review posted
  Orchestrator->>Wiki: update memory with decision and PR link
```

PR rules:

- Each PR description links the mission, relevant wiki pages, tests run, and
  review expectations.
- Agents should not merge their own PRs by default.
- A relevant peer agent reviews before merge.
- If checks fail, the author agent gets a follow-up run.
- If review requests changes, the author agent gets a follow-up run.
- The human owner may override, merge, close, or pause any PR.

Use `gh` for:

- `gh auth status`
- `gh repo view`
- `gh pr create`
- `gh pr view`
- `gh pr checks`
- `gh pr review`
- `gh pr merge`

## Onboarding Flow

The onboarding flow must run before the main workspace becomes active.

Steps:

1. Select or enter the target GitHub repository.
2. Select the local workspace path.
3. Verify Codex CLI exists.
4. Verify Codex ChatGPT auth by checking `CODEX_HOME` and running a harmless
   Codex command.
5. Verify `gh auth status`.
6. Verify repo access with `gh repo view`.
7. Verify the local repo exists, has a remote, and can fetch.
8. Choose default branch and agent branch prefix.
9. Create default wiki pages.
10. Create initial channels: `general`, `engineering`, `reviews`, `wiki-updates`.
11. Create optional starter employees.
12. Persist settings and show the main workspace.

Failed checks are saved in `onboarding_checks` and shown as Windows 95-style
setup checklist rows with retry buttons.

## API Surface

All APIs are versioned under `/api/v1`.

Agents:

- `GET /agents`
- `POST /agents`
- `GET /agents/:id`
- `PATCH /agents/:id`
- `DELETE /agents/:id`
- `POST /agents/:id/run`
- `POST /agents/:id/stop`

Conversations:

- `GET /conversations`
- `POST /conversations`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages`
- `POST /conversations/:id/loop/start`
- `POST /conversations/:id/loop/stop`

Wiki:

- `GET /wiki/spaces`
- `GET /wiki/pages`
- `POST /wiki/pages`
- `GET /wiki/pages/:slug`
- `PATCH /wiki/pages/:slug`
- `GET /wiki/pages/:slug/revisions`
- `GET /wiki/pages/:slug/backlinks`
- `POST /wiki/search`

Search and commands:

- `POST /search`
- `GET /commands`
- `POST /commands/:id`

GitHub:

- `GET /github/status`
- `POST /github/onboard`
- `GET /github/prs`
- `GET /github/prs/:number`
- `POST /github/prs/:number/review`

Stats:

- `GET /stats/agents`
- `GET /stats/tokens`
- `GET /stats/prs`
- `GET /stats/runs`

Settings and events:

- `GET /settings`
- `PATCH /settings`
- `GET /events`

## Global Search And Command Palette

`Cmd+K` is both search and action launcher.

Searchable entities:

- Agents and DMs.
- Channels.
- Wiki pages, headings, aliases, backlinks, and page body.
- Messages.
- PRs and reviews.
- Runs and blockers.
- Settings.
- Commands.

Command examples:

- New employee.
- New channel.
- New wiki page.
- Open settings.
- Start channel loop.
- Stop selected agent.
- Assign reviewer.
- Open shortcuts.
- Search wiki memory.
- Jump to PR.

The palette displays Windows 95-style sections with small icons, shortcut hints,
and status text. It uses backend FTS for persisted content and local command
registration for actions.

## Statistics

The stats page answers whether the agent company is productive and what it costs.

Metrics:

- Input, cached input, output, reasoning, and total tokens by agent.
- Token usage by run, channel, day, and model.
- PRs opened, merged, closed, and awaiting review by agent.
- Reviews submitted by agent.
- Average run duration.
- Time spent `working`, `idle`, `blocked`, and `reviewing`.
- Wiki pages created and edited by agent.
- Most linked wiki pages.
- Failed checks and rework rate.

The first version can use simple charts with shadcn chart components or a small
Recharts island. Persist raw usage so charting can evolve without data loss.

## Mockup Generation Workflow

Use `gpt-image-2` to generate visual mockups before implementing major frontend
screens.

Mockup targets:

- Main Slack-like workspace with left sidebar, chat center, right agent profile.
- Wiki editor with page tree, Markdown editor, preview, backlinks, and revision
  bar.
- Command palette with Windows 95-inspired styling.
- Stats page.
- Onboarding setup wizard.

Mockup prompts must specify:

- Windows 95-inspired but mildly modern.
- Dense operational software, not a landing page.
- Slack-like layout with DMs, channels, and wikis.
- Readable text scale and no overlapping UI.
- Neutral gray surfaces, dark title bars, compact controls, bevels, status bars.

Store approved mockups under:

```text
frontend/src/assets/mockups/
```

The implementation should translate the mockups into real HTML/CSS components,
not use mockups as opaque screenshots in the app.

## Runtime Architecture

The production app runs directly on the host. It is intentionally not containerized:
Agent Adda agents need direct access to Docker, GitHub CLI auth, Codex auth,
worktrees, and host-mounted app storage.

```mermaid
flowchart TB
  Host[Linux host]
  Host --> Tailscale[Tailscale + MagicDNS]
  Host --> Launcher[scripts/agent_adda.sh]
  Launcher --> PG[Postgres on 127.0.0.1:15432]
  Launcher --> API[Rocket backend on 0.0.0.0:4322]
  Launcher --> UI[Astro frontend on 0.0.0.0:4321]
  API --> Runtime[.runtime]
  API --> Workspaces[workspace root]
  API --> Apps[app storage root]
  API --> CodexHome[CODEX_HOME]
  API --> GhConfig[GitHub CLI config]
```

Launcher sketch:

```bash
scripts/agent_adda.sh
```

Default process map:

- Postgres: `postgres` from `AGENT_ADDA_PG_BIN_DIR` or `PATH` on `127.0.0.1:15432`.
- Backend: `backend/target/debug/agent_adda_backend` on `0.0.0.0:4322`.
- Frontend: npm-launched Astro dev server on `0.0.0.0:4321`.

The eventual `hraid` integration should mirror existing service roles without
wrapping Agent Adda itself in Docker:

- Add `agent_adda_frontend_port`.
- Add `agent_adda_backend_port`.
- Add `agent_adda_postgres_port`.
- Add `agent_adda_repo_dir`.
- Add `agent_adda_runtime_dir`.
- Ensure the repo, Codex home, `gh` config, and Brew dependencies exist before
  launching.
- Run `scripts/agent_adda.sh` under a host process supervisor.
- Optionally add a private dashboard link and Tailscale Serve route.

## Security And Safety

V1 is private and single-owner, but agents can run code and use GitHub. Treat the
orchestrator as a privileged local automation system.

Controls:

- Bind only to Tailscale or expose only through a private Tailscale hostname.
- Require onboarding checks before any agent run.
- Store no GitHub tokens in Postgres; rely on mounted `gh` auth.
- Store no ChatGPT credentials in Postgres; rely on mounted `CODEX_HOME`.
- Show active runs and allow immediate stop.
- Log every Codex invocation, agent status change, PR command, and wiki write.
- Keep immutable audit history for messages, runs, PRs, and wiki revisions.
- Soft-delete employees instead of erasing history.
- Render Markdown through sanitization before display.
- Limit concurrent runs globally and per agent.
- Add a per-agent branch prefix to reduce branch collisions.

Default concurrency:

- Global max active agent runs: `2`.
- Per-agent max active runs: `1`.
- Channel loop interval: configurable, default `10 minutes`.
- Idle retry backoff after blockers or failures.

## Testing Strategy

Backend unit tests:

- Prompt generation includes wiki, PR, and review obligations.
- Agent status transitions are valid.
- Wiki link extraction handles `[[Page]]`, normal Markdown links, headings, and
  deleted pages.
- Backlinks update after page edits.
- FTS search returns agents, messages, wiki pages, and PRs.
- Model settings validate supported reasoning efforts.

Backend integration tests:

- Postgres migrations apply cleanly.
- Agent create/delete preserves history.
- Wiki revision write updates page, revisions, links, backlinks, and FTS.
- Onboarding checks handle missing Codex, missing `gh`, missing repo, and
  successful setup.
- Mocked `gh` service creates and reviews PR records.
- Event stream emits run, message, status, and wiki events.

Frontend tests:

- Sidebar renders DMs, channels, wikis, and status labels.
- Right sidebar edits and saves agent prompt.
- `Cmd+K` opens palette, searches entities, and executes commands.
- Wiki editor saves Markdown, previews Mermaid, and shows backlinks.
- Stats page displays token and PR data by agent.
- Onboarding checklist retries failed checks.

End-to-end tests:

- Complete onboarding.
- Create an employee from a one-sentence description.
- Chat with the employee in DM.
- Start and stop a channel loop.
- Edit a wiki page and find it through `Cmd+K`.
- Simulate an agent run that opens a PR and assigns a reviewer.
- Simulate review completion and wiki memory update.

Visual checks:

- Desktop and mobile layouts.
- No overlapping text in sidebars, buttons, labels, title bars, or palette rows.
- Windows 95-inspired controls remain readable.
- Command palette and modal focus handling works with keyboard only.

## Implementation Milestones

Milestone 1: Repository scaffold.

- Astro + React + Tailwind frontend.
- Rocket backend.
- Postgres migrations.
- Host launcher script.
- Static shell with Windows 95-inspired design tokens.

Milestone 2: Core workspace.

- Sidebar, DMs, channels, wikis routes.
- Agents CRUD and right profile sidebar.
- Messages and event stream.
- Settings page with model/reasoning defaults.

Milestone 3: Wiki memory.

- Markdown editor and preview.
- Wiki pages, revisions, backlinks, search, and Mermaid.
- Default wiki pages and agent prompt memory clause.

Milestone 4: Codex orchestration.

- Codex auth check.
- Run manager.
- Agent status updates.
- Token usage capture.
- Stop/retry controls.

Milestone 5: GitHub workflow.

- GitHub onboarding through `gh`.
- Branch/PR creation.
- Reviewer assignment.
- Review runs.
- PR and review stats.

Milestone 6: Polish and operations.

- `Cmd+K` global search and shortcuts.
- Stats dashboard.
- gpt-image-2 mockup-guided UI pass.
- Tailscale deployment integration.
- E2E and visual regression checks.

## References

- Astro Docs MCP: `https://mcp.docs.astro.build/mcp`
- Astro Docs MCP repository: `https://github.com/withastro/docs-mcp`
- OpenAI models: `https://developers.openai.com/api/docs/models`
- GPT Image 2: `https://developers.openai.com/api/docs/models/gpt-image-2`
- GPT-5-Codex: `https://developers.openai.com/api/docs/models/gpt-5-codex`
