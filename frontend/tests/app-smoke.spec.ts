import { expect, test, type Page } from "@playwright/test";

type SmokeRoute = {
  path: string;
  heading: RegExp;
  prepare?: (page: Page) => Promise<void>;
  ready: (page: Page) => Promise<void>;
};

const smokeRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const traceCommand = "python -m datasets.tokenize --source aci-bench --tokenizer google/gemma-4-E2B-it --output /tmp/agent-adda-datasets/sources/aci-bench/tokenized/stats.json";

const routes: readonly SmokeRoute[] = [
  {
    path: "/",
    heading: /Agent Adda - Mission Control/i,
    ready: async (page: Page) => {
      await expect(page.getByPlaceholder("Message room or assign agent...")).toBeVisible();
      await expectBackendOnline(page);
      if (!isMobileViewport(page)) {
        await expect(page.getByText("API OK").first()).toBeVisible();
      }
      if (isMobileViewport(page)) {
        await expect(page.getByRole("navigation", { name: "Mobile taskbar" })).toBeVisible();
      } else {
        await expect(page.locator("[data-aa-message-log]")).toBeVisible();
      }
    },
  },
  {
    path: "/wiki",
    heading: /Agent Adda - Wiki Memory/i,
    prepare: ensureOperatingManualWiki,
    ready: async (page: Page) => {
      await expectNoBackendFallback(page);
      const emptyWiki = page.getByText("Backend wiki has no pages yet. Create a page to seed shared memory.");
      if (await emptyWiki.isVisible().catch(() => false)) {
        await expect(page.getByRole("button", { name: "New Page" }).last()).toBeVisible();
        return;
      }
      if (isMobileViewport(page)) {
        await expect(page.getByRole("button", { name: "Pages" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Info" })).toBeVisible();
      } else {
        await expect(page.getByText(/Shared memory online - \d+ pages indexed/i)).toBeVisible();
        await expect(page.getByRole("navigation", { name: "Wiki pages" })).toBeVisible();
      }
      await expect(page.getByRole("article").getByRole("heading", { name: "Agent Operating Manual", level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    },
  },
  {
    path: "/run-builder",
    heading: /Agent Adda - Run Builder/i,
    prepare: async (page: Page) => {
      await createSmokeAgent(page, "Route Planner");
    },
    ready: async (page: Page) => {
      await expectBackendOnline(page);
      await expect(page.getByText("Run Builder - Backend Plan")).toBeVisible();
      await expect(page.getByLabel("Agent", { exact: true })).toBeEnabled();
      await expect(page.getByLabel("Prompt", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create Plan" })).toBeVisible();
    },
  },
  {
    path: "/ops",
    heading: /Agent Adda - Ops Desk/i,
    ready: async (page: Page) => {
      await expectBackendOnline(page);
      await expect(page.getByText("Run Events - Recent Activity")).toBeVisible();
      await expect(page.getByText("Backend event log connected.")).toBeVisible();
    },
  },
  {
    path: "/stats",
    heading: /Agent Adda - Statistics/i,
    ready: async (page: Page) => {
      await expectBackendOnline(page);
      await expect(page.getByText("Stats Dashboard")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Run Status" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Agent Token IO" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Model Token Mix" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Employees Over Time" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Agent Performance" })).toBeVisible();
      await expect(page.getByText("ChatGPT Quota")).toBeVisible();
      await expect(page.getByText("Tasks In Flight")).toBeVisible();
      await expect(page.getByText("PRs Merged")).toBeVisible();
      if (isMobileViewport(page)) {
        await expect(page.getByRole("link", { name: "Agent Mode" })).toBeVisible();
      } else {
        await expect(page.getByRole("button", { name: "Agent Mode" })).toBeVisible();
      }
    },
  },
];

const viewports = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

const onboardingSettings = [
  setting("project_name", "Smoke Workspace"),
  setting("default_model", "gpt-5.5"),
  setting("default_reasoning_effort", "high"),
  setting("codex_binary_path", "/tmp/fake-codex"),
  setting("codex_home", "/tmp/fake-codex-home"),
  setting("workspace_path", "/tmp/fake-workspace"),
  setting("github_repo", "agent/adda"),
  setting("agent_global_system_prompt", "Smoke global system prompt."),
  setting("wiki_memory_required", "true"),
  setting("wiki_updates_required", "true"),
  setting("peer_review_required", "true"),
  setting("human_approval_required", "false"),
  setting("global_max_active_runs", "2"),
  setting("idle_timeout_minutes", "30"),
  setting("daily_token_budget", "1000000"),
] as const;

const onboardingChecks = [
  check("gh_auth", "GitHub CLI auth", "passed", "fake gh authenticated"),
  check("github_repo", "GitHub repository", "passed", "fake repo visible: agent/adda"),
  check("codex_binary", "Codex CLI binary", "passed", "fake codex 5.5.0"),
  check("codex_home", "Codex home", "passed", "fake Codex home exists"),
  check("workspace_path", "Workspace path", "passed", "fake workspace exists"),
] as const;

for (const route of routes) {
  test(`${route.path} route renders`, async ({ page }) => {
    await route.prepare?.(page);
    await openRoute(page, route.path);

    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await route.ready(page);
  });
}

test("sidebar wiki navigation opens the wiki route", async ({ page }) => {
  await ensureOperatingManualWiki(page);
  await openRoute(page, "/");

  await page.getByRole("link", { name: "Wiki Memory" }).click();

  await expect(page).toHaveURL(/\/wiki$/);
  await expect(page.getByRole("heading", { name: /Agent Adda - Wiki Memory/i })).toBeVisible();
  await expect(page.getByText(/Shared memory online - \d+ pages indexed/i)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Wiki pages" })).toBeVisible();
  await expect(page.getByRole("article").getByRole("heading", { name: "Agent Operating Manual", level: 1 })).toBeVisible();
});

test("wiki shell uses wiki hierarchy sidebar and opens settings", async ({ page }) => {
  await ensureOperatingManualWiki(page);
  await openRoute(page, "/wiki");
  await expectBackendOnline(page);

  await expect(page.getByText("2 runs active")).toHaveCount(0);
  await expect(page.getByText("Wiki mode", { exact: true })).toBeVisible();
  await expect(page.getByText("Rooms", { exact: true }).first()).toBeHidden();
  await expect(page.getByText("Direct Messages", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Wiki pages" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Agent Operating Manual/ })).toBeVisible();

  await page.locator("[data-aa-open-settings]").first().click();
  const dialog = page.getByRole("dialog", { name: /Agent Runtime Defaults/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /Edit Agent Operating Manual/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByRole("article").getByRole("heading", { name: "Agent Operating Manual", level: 1 })).toBeVisible();
});

test("command palette opens global search and closes", async ({ page }) => {
  await openRoute(page, "/");

  const palette = page.locator("#aa-command-palette");
  if ((await palette.count()) === 0) {
    return;
  }

  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: /Global Search/i });
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Type to search DMs, wiki pages, rooms, agents, and settings.")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("global search fuzzy searches live DMs and wiki pages by section", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Fuzzy Search Agent");
  await ensureOperatingManualWiki(page);

  await openRoute(page, "/wiki");

  await page.getByRole("button", { name: "Global Search" }).click();
  const dialog = page.getByRole("dialog", { name: /Global Search/i });
  await expect(dialog).toBeVisible();

  const results = page.locator("#aa-command-results");
  const input = page.getByPlaceholder("Type to search Agent Adda...");
  await input.fill("Fzzy Search Agnt");
  await expect(results.locator(".aa-command-section").first()).toHaveText("DMs");
  await expect(results.getByText(agent.name).first()).toBeVisible();

  await input.fill("Agnt Operating Manual");
  await expect(results.locator(".aa-command-section").first()).toHaveText("Wiki");
  await results.getByRole("button", { name: /Agent Operating Manual/ }).click();
  await expect(page).toHaveURL(/\/wiki#agent-operating-manual$/);
  await expect(page.getByRole("article").getByRole("heading", { name: "Agent Operating Manual", level: 1 })).toBeVisible();
});

test("global search shows matched snippets and clears highlights with Escape", async ({ page }) => {
  await ensureOperatingManualWiki(page);
  await openRoute(page, "/wiki");

  await page.getByRole("button", { name: "Global Search" }).click();
  const dialog = page.getByRole("dialog", { name: /Global Search/i });
  await expect(dialog).toBeVisible();

  const results = page.locator("#aa-command-results");
  const input = page.getByPlaceholder("Type to search Agent Adda...");
  await input.fill("durable knowledge");

  await expect(results.locator(".aa-command-section").first()).toHaveText("Wiki");
  await expect(results.getByText("Body:", { exact: true }).first()).toBeVisible();
  await expect(results.locator("mark.aa-search-highlight").filter({ hasText: "durable knowledge" }).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(results.locator("mark.aa-search-highlight")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("startup wizard auto-opens when onboarding is incomplete and can be canceled for the session", async ({ page }) => {
  await mockOnboardingStatus(page, false);

  await openRoute(page, "/", { dismissStartupWizard: false });

  await expect(page.getByRole("navigation", { name: "Application menu" })).toHaveCount(0);

  const dialog = page.getByRole("dialog", { name: /First-Run Onboarding/i });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Close onboarding" }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Setup is incomplete.")).toBeVisible();

  await page.getByRole("button", { name: "Run setup wizard" }).click();
  await expect(dialog).toBeVisible();
});

test("shared shell removes the dead top application menu but keeps the toolbar", async ({ page }) => {
  await openRoute(page, "/");

  await expect(page.getByRole("navigation", { name: "Application menu" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run Agents" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New Room" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Global Search" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stats" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wiki Mode" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings ▾" })).toHaveCount(0);
  await expect(page.locator("[data-aa-open-settings]").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Runtime settings" })).toHaveCount(0);
  await expect(page.getByText("Agent Fleets")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add room" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
});

test("mission control opens chat first on mobile and exposes navigation from the taskbar", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRoute(page, "/");

  await expectBackendOnline(page);
  await expect(page.getByRole("navigation", { name: "Mobile taskbar" })).toBeVisible();
  await expect(page.getByPlaceholder("Message room or assign agent...")).toBeVisible();
  await expect(page.getByText("Rooms", { exact: true }).first()).toBeHidden();
  await expect(page.locator("[data-aa-message-log]")).toBeVisible();
  await expectFixedMobileViewport(page);

  await page.locator("[data-aa-mobile-tab='chats']").click();
  await expect(page.getByRole("button", { name: "Add room" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add agent" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("top toolbar switches between agent and wiki modes", async ({ page }) => {
  await openRoute(page, "/");

  await page.getByRole("button", { name: "Wiki Mode" }).click();
  await expect(page).toHaveURL(/\/wiki\/?$/);
  await expect(page.getByRole("heading", { name: /Agent Adda - Wiki Memory/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Agent Mode" })).toBeVisible();

  await page.getByRole("button", { name: "Agent Mode" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: /Agent Adda - Mission Control/i })).toBeVisible();
});

test("DM sidebar shows a blue status dot when the selected agent run is running", async ({ page }) => {
  const { agent, otherAgent } = await mockRunningDmSidebar(page);

  await openRoute(page, `/#dm_${agent.id}`);

  const dmButton = page.getByRole("button", { name: agent.name, exact: true });
  await expect(dmButton).toBeVisible();
  await expect(dmButton.getByText("Engineer", { exact: true })).toBeVisible();
  const dot = dmButton.locator(".status-dot");
  await expect(dot).toHaveClass(/status-running/);
  await expect(dot).toHaveCSS("background-color", "rgb(11, 98, 216)");
  const runQueue = page.getByRole("heading", { name: "Run Queue" });
  await expect(runQueue.locator(".status-dot")).toHaveClass(/status-running/);
  await expect(runQueue.locator(".status-dot")).toHaveCSS("background-color", "rgb(11, 98, 216)");
  await expect(page.getByText("Loading runs...")).toHaveCount(0);

  await page.getByRole("button", { name: otherAgent.name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#dm_${escapeRegExp(otherAgent.id)}$`));
  await expect(dot).toHaveClass(/status-running/);
  await expect(dot).toHaveCSS("background-color", "rgb(11, 98, 216)");
});

test("queued and running run lights use different colors", async ({ page }) => {
  const agent = await mockDmTraceMessages(page);

  await openRoute(page, `/#dm_${agent.id}`);

  const queuedMessage = page.locator("[data-aa-message-run-id='run_trace_queued']");
  await expect(queuedMessage).toBeVisible();
  const queuedDot = queuedMessage.locator("[data-aa-message-run-status='queued']");
  await expect(queuedDot).toHaveClass(/status-queued/);
  await expect(queuedDot).toHaveCSS("background-color", "rgb(255, 242, 0)");

  const runningMessage = page.locator("[data-aa-message-run-id='run_trace_running']");
  const runningDot = runningMessage.locator("[data-aa-message-run-status='running']");
  await expect(runningDot).toHaveClass(/status-running/);
  await expect(runningDot).toHaveCSS("background-color", "rgb(11, 98, 216)");
});

test("DM sidebar clears stale green agent status when no run is active", async ({ page }) => {
  const agent = await mockStaleWorkingDmSidebar(page);

  await openRoute(page, `/#dm_${agent.id}`);

  const dmButton = page.getByRole("button", { name: agent.name, exact: true });
  await expect(dmButton).toBeVisible();
  const dot = dmButton.locator(".status-dot");
  await expect(dot).toHaveClass(/status-idle/);
  await expect(dot).toHaveCSS("background-color", "rgb(223, 223, 223)");
  await expect(page.getByText("0 agents active")).toBeVisible();
});

test("opening a DM scrolls the transcript to the latest message", async ({ page }) => {
  const agent = await mockLongDmTranscript(page);

  await openRoute(page, `/#dm_${agent.id}`);

  const messageLog = page.locator("[data-aa-message-log]");
  await expect(messageLog).toBeVisible();
  await expect(page.getByText("Latest mocked DM message")).toBeInViewport({ ratio: 1 });
});

test("run-linked DM messages show Codex thinking status and trace output", async ({ page }) => {
  const agent = await mockDmTraceMessages(page);

  await openRoute(page, `/#dm_${agent.id}`);

  const thinkingMessage = page.locator("[data-aa-message-run-id='run_trace_running']");
  await expect(thinkingMessage).toBeVisible();
  await expect(thinkingMessage.getByText("Open trace")).toBeVisible();
  const thinkingDot = thinkingMessage.locator("[data-aa-message-run-status='running']");
  await expect(thinkingDot).toHaveCSS("background-color", "rgb(11, 98, 216)");

  const agentReply = page.locator("article").filter({ hasText: "Dataset summary committed." });
  await expect(agentReply).toHaveAttribute("data-aa-message-run-id", "run_trace_done");
  await expect(agentReply).toHaveAttribute("role", "button");
  await expect(agentReply.getByText("Open trace")).toBeVisible();
  await expect(agentReply).toContainText("Implemented the dashboard Linuxbrew PATH change.");
  await expect(agentReply).toContainText("docker compose up --build -d app-dashboard");
  await expect(agentReply).not.toContainText("agent_adda.actions");
  await expect(agentReply).not.toContainText("wiki_upsert");
  await expect(agentReply).not.toContainText("body_markdown");

  const systemFailure = page.locator("article").filter({ hasText: "Run failed before producing a DM reply." });
  await expect(systemFailure).not.toHaveAttribute("data-aa-message-run-id", "run_trace_error");
  await expect(systemFailure).not.toHaveAttribute("role", "button");

  const doneDots = page.locator("[data-aa-message-run-id='run_trace_done'] [data-aa-message-run-status='done']");
  await expect(doneDots).toHaveCount(2);
  await expect(doneDots.first()).toHaveCSS("background-color", "rgb(0, 197, 47)");
  await expect(doneDots.last()).toHaveCSS("background-color", "rgb(0, 197, 47)");

  const errorDot = page.locator("[data-aa-message-run-id='run_trace_error'] [data-aa-message-run-status='error']");
  await expect(errorDot).toHaveCSS("background-color", "rgb(197, 22, 22)");

  await thinkingMessage.click();

  const dialog = page.getByRole("dialog", { name: "Codex Thinking" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("User query")).toBeVisible();
  await expect(dialog.getByText("start dataset compilation")).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Thinking trace" })).toBeVisible();
  await expect(dialog.getByText("Current Thought Process")).toHaveCount(0);
  const trace = dialog.getByLabel("Thinking trace");
  await expect(trace).toContainText("Agent Reasoning");
  await expect(trace).toContainText("Inspecting dataset shards");
  await expect(trace).toContainText("Thread Started");
  await expect(trace).toContainText("Thread ID");
  await expect(trace).toContainText("019dd7e3-9154-7132-9f4d-5bbf4e36d085");
  await expect(trace).toContainText("Agent Message");
  await expect(trace).toContainText("Hi. I am here and ready for the next dataset task.");
  await expect(trace).toContainText("Turn Completed");
  await expect(trace).toContainText("Input tokens");
  await expect(trace).toContainText("34,841");
  await expect(trace).toContainText("plain stdout checkpoint");
  await expect(trace).not.toContainText('{"thread_id"');
  await expect(trace.getByText("Item Started")).toHaveCount(0);
  await expect(trace.getByText("Item ID")).toHaveCount(0);
  await expect(trace.getByText("item.completed")).toHaveCount(0);
  await expect(trace.getByText("Command Execution")).toBeVisible();
  const agentOnlyCheckbox = dialog.getByRole("checkbox", { name: "Only show Agent messages" });
  await expect(agentOnlyCheckbox).toBeVisible();
  await expect(agentOnlyCheckbox).not.toBeChecked();
  await agentOnlyCheckbox.check();
  await expect(trace).toContainText("Agent Message");
  await expect(trace).toContainText("Hi. I am here and ready for the next dataset task.");
  await expect(trace).not.toContainText("Thread Started");
  await expect(trace).not.toContainText("Turn Completed");
  await expect(trace).not.toContainText("Command Execution");
  await expect(trace).not.toContainText("plain stdout checkpoint");
  await agentOnlyCheckbox.uncheck();
  await expect(trace.getByText("Command Execution")).toBeVisible();
  const commandDetails = trace.locator("details").filter({ hasText: "python -m datasets.tokenize" });
  await expect(commandDetails).toHaveCount(1);
  await commandDetails.locator("summary").click();
  await expect(commandDetails.getByLabel("Full command")).toHaveValue(traceCommand);
  await expect(trace.getByLabel("Command output")).toHaveValue("tokenized 207 visits");
  await expect(dialog.getByText("failed to record rollout items")).toHaveCount(0);
  const stderr = dialog.locator("details").filter({ hasText: "Stderr" });
  await expect(stderr).toHaveCount(1);
  await expect(stderr.locator("pre")).toBeHidden();
  await expect(dialog.getByText("stderr diagnostic checkpoint")).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await agentReply.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Agent response")).toBeVisible();
  await expect(dialog.getByText("User query")).toHaveCount(0);
  await expect(dialog.getByText("Implemented the dashboard Linuxbrew PATH change.")).toBeVisible();
  await expect(dialog.getByText("agent_adda.actions")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("toolbar stats button opens the statistics dashboard", async ({ page }) => {
  await openRoute(page, "/");

  await page.getByRole("button", { name: "Stats" }).click();

  await expect(page).toHaveURL(/\/stats$/);
  await expect(page.getByRole("heading", { name: /Agent Adda - Statistics/i })).toBeVisible();
  await expect(page.getByText("Stats Dashboard")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent Performance" })).toBeVisible();
});

test("stats dashboard captures token quota, in-flight task, merged PR, and employee metrics", async ({ page }) => {
  await mockStatsDashboard(page);
  await openRoute(page, "/stats");

  const dashboard = page.locator("section[aria-label='Statistics dashboard']");
  const headline = dashboard.locator("section[aria-label='Headline statistics']");
  await expect(headline.getByText("Input Tokens")).toBeVisible();
  await expect(headline.getByText("12.3K")).toBeVisible();
  await expect(headline.getByText("Output Tokens")).toBeVisible();
  await expect(headline.getByText("4.6K")).toBeVisible();
  await expect(headline.getByText("ChatGPT Quota")).toBeVisible();
  await expect(headline.getByText("3.4K / 10K")).toBeVisible();
  await expect(headline.getByText("34% used today")).toBeVisible();
  await expect(headline.getByText("Tasks In Flight")).toBeVisible();
  await expect(headline.getByText("2 active / 1 queued")).toBeVisible();
  await expect(headline.getByText("PRs Merged")).toBeVisible();
  await expect(dashboard.getByText("Metrics Engineer").last()).toBeVisible();
  await expect(dashboard.getByRole("heading", { name: "Employees Over Time" })).toBeVisible();
});

test("sidebar section toggles collapse and expand content", async ({ page }) => {
  await openRoute(page, "/");

  const wikiLink = page.getByRole("link", { name: "Wiki Memory" });
  await expect(wikiLink).toBeVisible();

  await page.getByRole("button", { name: "Collapse Wikis" }).click();
  await expect(page.getByRole("button", { name: "Expand Wikis" })).toHaveAttribute("aria-expanded", "false");
  await expect(wikiLink).toBeHidden();

  await page.getByRole("button", { name: "Expand Wikis" }).click();
  await expect(page.getByRole("button", { name: "Collapse Wikis" })).toHaveAttribute("aria-expanded", "true");
  await expect(wikiLink).toBeVisible();
});

test("sidebar plus buttons create backend rooms and agents", async ({ page }) => {
  await openRoute(page, "/");
  await expectBackendOnline(page);

  const roomName = `sidebar-room-${uniqueSuffix()}`;
  const roomTopic = `Sidebar room topic ${uniqueSuffix()}`;
  const roomResponsePromise = page.waitForResponse((response) => {
    return response.url().endsWith("/api/v1/conversations") && response.request().method() === "POST";
  });

  await page.getByRole("button", { name: "Add room" }).click();
  const roomDialog = page.getByRole("dialog", { name: "Create Room" });
  await expect(roomDialog).toBeVisible();
  await roomDialog.getByLabel("Room name").fill(roomName);
  await roomDialog.getByLabel("Topic").fill(roomTopic);
  await roomDialog.getByRole("button", { name: "Create" }).click();

  const roomResponse = await roomResponsePromise;
  await expectApiOk(roomResponse, "create sidebar room");
  await expect(roomDialog).toBeHidden();
  await expect(page.getByRole("button", { name: `# ${roomName}` })).toBeVisible();
  await expect(page.getByText(roomTopic).first()).toBeVisible();

  const agentName = `Sidebar Agent ${uniqueSuffix()}`;
  const agentDescription = "Created from the sidebar plus button.";
  const agentResponsePromise = page.waitForResponse((response) => {
    return response.url().endsWith("/api/v1/agents") && response.request().method() === "POST";
  });

  await page.getByRole("button", { name: "Add agent" }).click();
  const agentDialog = page.getByRole("dialog", { name: "New Agent" });
  await expect(agentDialog).toBeVisible();
  await agentDialog.getByLabel("Agent name").fill(agentName);
  await agentDialog.getByLabel("Role").fill("Researcher");
  await agentDialog.getByLabel("Description").fill(agentDescription);
  await agentDialog.getByRole("button", { name: "Create" }).click();

  const agentResponse = await agentResponsePromise;
  await expectApiOk(agentResponse, "create sidebar agent");
  const agent = (await agentResponse.json()) as { id: string; name: string };
  await expect(agentDialog).toBeHidden();
  await expect(page.getByRole("button", { name: agent.name, exact: true })).toBeVisible();
  await expect(page.getByText(`Direct message with ${agent.name}`).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#dm_${escapeRegExp(agent.id)}$`));
});

test("settings onboarding modal loads and runs checks through the API", async ({ page }) => {
  let checksRun = false;

  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(onboardingSettings),
    });
  });
  await page.route("**/api/v1/github/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: true,
        detail: "fake gh authenticated",
      }),
    });
  });
  await page.route("**/api/v1/onboarding/checks/run", async (route) => {
    expect(route.request().method()).toBe("POST");
    checksRun = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ checks: onboardingChecks }),
    });
  });

  await openRoute(page, "/");
  await page.locator("[data-aa-open-settings]").first().click();

  const dialog = page.getByRole("dialog", { name: /Agent Runtime Defaults/i });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#aa-settings-message")).toHaveText("Settings loaded.");
  await expect(page.locator("#default-model")).toHaveValue("gpt-5.5");
  await expect(page.locator("#reasoning-effort")).toHaveValue("high");
  await expect(page.locator("#agent-global-system-prompt")).toHaveValue("Smoke global system prompt.");
  await expect(page.locator("#reasoning-effort option")).toHaveText(["low", "medium", "high", "xhigh"]);
  await expect(page.locator("#aa-github-status")).toHaveText("Authenticated");
  await expect(page.getByLabel("Channel loop interval")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Run Checks" }).click();

  await expect(page.locator("#aa-settings-message")).toHaveText("Onboarding checks updated.");
  for (const result of onboardingChecks) {
    await expect(page.locator("#aa-onboarding-checks").getByText(result.label, { exact: true })).toBeVisible();
    await expect(page.locator("#aa-onboarding-checks").getByText(result.detail, { exact: true })).toBeVisible();
  }
  expect(checksRun).toBe(true);
});

test("agent setup assigns cron jobs to a DM agent", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Cron Setup Agent");
  const title = `Daily wiki summary ${uniqueSuffix()}`;
  const prompt = `Write yesterday's work summary into the wiki ${uniqueSuffix()}.`;
  await upsertSetting(page, "workspace_path", "/tmp/fake-workspace");

  await openAgentDm(page, agent);
  await page.getByRole("button", { name: "Setup", exact: true }).click();

  const setupDialog = page.getByRole("dialog", { name: /Planner Setup/i });
  await expect(setupDialog).toBeVisible();
  await expect(setupDialog.getByRole("heading", { name: "Cron Jobs" })).toBeVisible();
  await expect(setupDialog.getByText(/No cron jobs assigned|cron job.*loaded/i)).toBeVisible();

  const createResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().endsWith(`/api/v1/agents/${agent.id}/cron-jobs`);
  });
  await setupDialog.getByLabel("Cron job title").fill(title);
  await setupDialog.getByLabel("At time of day (PDT)").check();
  await setupDialog.getByRole("textbox", { name: "Time of day (PDT)" }).fill("09:30");
  await setupDialog.getByLabel("Cron job prompt").fill(prompt);
  await setupDialog.getByRole("button", { name: "Add cron job" }).click();

  const createResponse = await createResponsePromise;
  await expectApiOk(createResponse, "create agent cron job");
  const created = (await createResponse.json()) as {
    id: string;
    title?: string;
    prompt?: string;
    interval_minutes?: number;
    schedule_kind?: string;
    time_of_day?: string;
    enabled?: boolean;
  };
  expect(created).toMatchObject({
    title,
    prompt,
    interval_minutes: 1440,
    schedule_kind: "daily_time",
    time_of_day: "09:30",
    enabled: true,
  });

  await expect(setupDialog.getByText(title, { exact: true })).toBeVisible();
  await expect(setupDialog.getByText(prompt, { exact: true })).toBeVisible();
  await expect(setupDialog.getByText("Daily at 09:30 PDT")).toBeVisible();
  await expect(setupDialog.getByRole("button", { name: `Run ${title} now` })).toBeVisible();

  const runNowResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().endsWith(`/api/v1/cron-jobs/${created.id}/run-now`);
  });
  await setupDialog.getByRole("button", { name: `Run ${title} now` }).click();
  const runNowResponse = await runNowResponsePromise;
  await expectApiOk(runNowResponse, "run cron job now");
  await expect(setupDialog.getByText(`${title} queued to run now.`)).toBeVisible();
  await setupDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(setupDialog).toBeHidden();
  await expect(page.locator("article").filter({ hasText: "Manual cron job queued" }).filter({ hasText: title })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: "Setup", exact: true }).click();
  await expect(setupDialog).toBeVisible();

  const listResponse = await page.request.get(`/api/v1/agents/${agent.id}/cron-jobs`);
  await expectApiOk(listResponse, "list agent cron jobs");
  const jobs = (await listResponse.json()) as Array<{ id?: string; title?: string }>;
  expect(jobs.some((job) => job.id === created.id && job.title === title)).toBe(true);

  await setupDialog.getByRole("button", { name: `Disable ${title}` }).click();
  await expect(setupDialog.getByText(`${title} disabled.`)).toBeVisible();

  await setupDialog.getByRole("button", { name: `Delete ${title}` }).click();
  await expect(setupDialog.getByText(`${title} deleted.`)).toBeVisible();
});

test("agent setup can delete the full DM history", async ({ page }) => {
  const agent = await createSmokeAgent(page, "History Delete Agent");
  const conversationId = `dm_${agent.id}`;
  const firstMessage = `History delete first ${uniqueSuffix()}`;
  const secondMessage = `History delete second ${uniqueSuffix()}`;

  for (const body of [firstMessage, secondMessage]) {
    const response = await page.request.post(`/api/v1/conversations/${conversationId}/messages`, {
      data: {
        author_kind: "human",
        author_id: "owner",
        body,
        delivery_mode: "message_only",
      },
    });
    await expectApiOk(response, "seed DM history message");
  }

  await openAgentDm(page, agent);
  await expect(page.locator("article").filter({ hasText: firstMessage })).toBeVisible();
  await expect(page.locator("article").filter({ hasText: secondMessage })).toBeVisible();

  await page.getByRole("button", { name: "Setup", exact: true }).click();
  const setupDialog = page.getByRole("dialog", { name: /Planner Setup/i });
  await expect(setupDialog).toBeVisible();
  await expect(setupDialog.getByRole("heading", { name: "DM History" })).toBeVisible();

  await setupDialog.getByRole("button", { name: "Delete DM history" }).click();
  await expect(setupDialog.getByText("Press Delete DM history again to permanently clear this transcript.")).toBeVisible();

  const deleteResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "DELETE" && response.url().endsWith(`/api/v1/conversations/${conversationId}/messages`);
  });
  await setupDialog.getByRole("button", { name: "Confirm delete" }).click();
  const deleteResponse = await deleteResponsePromise;
  await expectApiOk(deleteResponse, "delete DM history");
  const deleted = (await deleteResponse.json()) as { deleted_messages?: number };
  expect(deleted.deleted_messages).toBe(2);
  await expect(setupDialog.getByText("Deleted 2 DM messages.")).toBeVisible();

  await setupDialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(setupDialog).toBeHidden();
  await expect(page.locator("article").filter({ hasText: firstMessage })).toHaveCount(0);
  await expect(page.locator("article").filter({ hasText: secondMessage })).toHaveCount(0);
  await expect(page.getByText("No messages in this room yet.")).toBeVisible();

  const listResponse = await page.request.get(`/api/v1/conversations/${conversationId}/messages`);
  await expectApiOk(listResponse, "load cleared DM messages");
  expect(await listResponse.json()).toEqual([]);
});

test("first-run onboarding initializes agents, wiki overview, and CEO task runs", async ({ page }) => {
  const workspacePath = "/tmp";
  await installFastCodex(page);
  const effortsResponse = await page.request.get("/api/v1/codex/reasoning-efforts?model=gpt-5.5");
  await expectApiOk(effortsResponse, "load gpt-5.5 reasoning efforts from Codex catalog");
  const efforts = (await effortsResponse.json()) as { reasoning_efforts?: string[]; source?: string };
  expect(efforts).toMatchObject({
    reasoning_efforts: ["low", "medium", "high", "xhigh"],
    source: "codex-debug-models",
  });

  await openRoute(page, "/", { dismissStartupWizard: false });

  const dialog = page.getByRole("dialog", { name: /First-Run Onboarding/i });
  await expect(dialog).toBeVisible();

  const suffix = uniqueSuffix();
  const projectName = `SmokeCo ${suffix}`;
  const projectSummary = `SmokeCo ${suffix} builds deterministic agent collaboration tools.`;
  const extraRoleName = `QA Steward ${suffix}`;
  const firstTask = `Triage launch blockers ${suffix}`;
  const secondTask = `Draft release notes ${suffix}`;

  await dialog.getByLabel("Project name").fill(projectName);
  await dialog.getByLabel("Project summary").fill(projectSummary);
  await dialog.getByLabel("Existing workspace path").fill(workspacePath);
  await expect(dialog.getByLabel("Default model")).toHaveValue("gpt-5.5");
  await expect(dialog.getByLabel("Reasoning effort")).toHaveValue("high");
  await expect(dialog.locator("#aa-onboarding-reasoning option")).toHaveText(["low", "medium", "high", "xhigh"]);

  await dialog.locator("fieldset").filter({ hasText: "Extra Roles" }).getByRole("button", { name: "Add" }).click();
  await dialog.getByLabel("Role 3 name").fill(extraRoleName);
  await dialog.getByLabel("Role 3 responsibility").fill("Quality owner");
  await dialog.getByLabel("Role 3 description").fill("Verifies onboarding and runtime flows with Playwright.");

  await dialog.getByLabel("Major task 1").fill(firstTask);
  await dialog.getByLabel("Major task 2").fill(secondTask);

  const initializeResponsePromise = page.waitForResponse((response) => {
    return response.url().endsWith("/api/v1/onboarding/initialize") && response.request().method() === "POST";
  });
  await dialog.getByRole("button", { name: "Initialize" }).click();

  const initializeResponse = await initializeResponsePromise;
  await expectApiOk(initializeResponse, "initialize onboarding through UI");
  const initialized = (await initializeResponse.json()) as {
    status?: { initialized?: boolean };
    agents?: Array<{ name?: string; model?: string; reasoning_effort?: string }>;
    overview_page_id?: string;
    queued_run_ids?: string[];
  };

  expect(initialized.status?.initialized).toBe(true);
  expect(initialized.overview_page_id).toBeTruthy();
  expect(initialized.queued_run_ids?.length).toBeGreaterThanOrEqual(4);
  expect(initialized.agents?.some((agent) => agent.name === "CEO" && agent.model === "gpt-5.5" && agent.reasoning_effort === "high")).toBe(true);
  expect(initialized.agents?.some((agent) => agent.name === extraRoleName)).toBe(true);

  await expect(dialog).toBeHidden();
  await expect(page.getByText("Setup is incomplete.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: extraRoleName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Founding Engineer", exact: true }).click();
  await expect(page.getByText("Direct message with Founding Engineer").first()).toBeVisible();
  await page.getByRole("button", { name: "Setup", exact: true }).click();

  const setupDialog = page.getByRole("dialog", { name: /Founding Engineer Setup/i });
  await expect(setupDialog).toBeVisible();
  await expect(setupDialog.getByLabel("Name")).toHaveValue("Unnamed");
  await setupDialog.getByLabel("Name").fill(`Engineer ${suffix}`);
  await setupDialog.getByLabel("Reasoning effort").selectOption("medium");
  const setupSaveResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "PATCH" && response.url().includes("/api/v1/agents/");
  });
  await setupDialog.getByRole("button", { name: "Save" }).click();
  const setupSaveResponse = await setupSaveResponsePromise;
  await expectApiOk(setupSaveResponse, "save founding engineer setup");
  await expect(setupDialog).toBeHidden({ timeout: 10_000 });
  await expect(page.getByText(`Engineer ${suffix}`).first()).toBeVisible();

  const statusResponse = await page.request.get("/api/v1/onboarding/status");
  await expectApiOk(statusResponse, "load onboarding status");
  const status = (await statusResponse.json()) as { initialized?: boolean; project_name?: string; project_summary?: string };
  expect(status.initialized).toBe(true);
  expect(status.project_name).toBe(projectName);
  expect(status.project_summary).toBe(projectSummary);
  await expect(page.locator("aside").filter({ hasText: projectName.slice(0, 19) }).first()).toBeVisible();

  const overviewResponse = await page.request.get("/api/v1/wiki/pages/company-overview");
  await expectApiOk(overviewResponse, "load company overview wiki page");
  const overview = (await overviewResponse.json()) as { body_markdown?: string };
  expect(overview.body_markdown).toContain(projectSummary);
  expect(overview.body_markdown).toContain(workspacePath);

  for (const runId of initialized.queued_run_ids ?? []) {
    const runResponse = await page.request.get(`/api/v1/runs/${runId}`);
    await expectApiOk(runResponse, `load onboarding run ${runId}`);
    const run = (await runResponse.json()) as { trigger_kind?: string; queued_by?: string; prompt_summary?: string };
    expect(run.trigger_kind).toBe("onboarding-task");
    expect(run.queued_by).toBe("onboarding");
  }
});

test("mission control sends a message through the backend", async ({ page }) => {
  await openRoute(page, "/");

  await expectBackendOnline(page);

  const marker = `backend smoke message ${uniqueSuffix()}`;
  const message = `**QA ${marker}**`;
  const composer = page.getByPlaceholder("Message room or assign agent...");
  const sendButton = page.getByRole("button", { name: "Send" });
  await composer.click();
  await composer.pressSequentially(message);
  await expect(composer).toHaveValue(message);
  await expect(sendButton).toBeEnabled();
  const createResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && /\/api\/v1\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname);
  });
  await sendButton.click();
  const createResponse = await createResponsePromise;
  await expectApiOk(createResponse, "send channel message");
  const sentMessage = (await createResponse.json()) as { conversation_id?: string };

  await expect(page.locator("strong").filter({ hasText: `QA ${marker}` })).toBeVisible();
  await expect(composer).toHaveValue("");

  const response = await page.request.get(`/api/v1/conversations/${sentMessage.conversation_id}/messages`);
  await expectApiOk(response, "load channel_general messages");
  const messages = (await response.json()) as Array<{ body?: string }>;
  expect(messages.some((candidate) => candidate.body === message)).toBe(true);
});

test("wiki creates and saves a backend memory page", async ({ page }) => {
  await openRoute(page, "/wiki");

  await expectNoBackendFallback(page);
  await expect(page.getByText(/Shared memory online - \d+ pages indexed/i)).toBeVisible();

  await page.getByRole("button", { name: "New Page", exact: true }).click();
  await expect(page.getByRole("heading", { name: /New Memory Page/i, level: 2 })).toBeVisible();

  const title = `Smoke Memory ${uniqueSuffix()}`;
  const marker = `Backend save verification ${uniqueSuffix()}.`;
  const source = [
    `# ${title}`,
    "",
    marker,
    "This page updates [[Datasets]], [[Medical Text Dataset Downloads]], and [[Dataset Tokenization Canary Attempt 2026-04-27]].",
    "Alias check: [[Agent Operating Manual|the operating manual]].",
    "Code should remain literal: `[[Do Not Link]]`.",
    "",
    "- [x] Saved by the Playwright backend smoke test.",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Source | Playwright |",
    "",
    "```ts",
    "const saved = true;",
    "```",
  ].join("\n");
  const editor = page.locator("textarea[aria-label^='Edit New Memory Page']").first();

  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+A");
  await editor.pressSequentially(source);
  await expect(editor).toHaveValue(source);
  await expect(page.getByText("Unsaved")).toBeVisible();

  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Saved new page to backend.")).toBeVisible();
  await expect(page.locator("textarea").first()).toHaveAttribute("aria-label", new RegExp(`Edit ${escapeRegExp(title)}`));
  await expect(page.locator("textarea").first()).toHaveValue(source);

  await page.getByRole("button", { name: "Preview", exact: true }).click();
  const article = page.getByRole("article");
  await expect(article.getByRole("heading", { name: title, level: 1 })).toBeVisible();
  await expect(article.getByRole("checkbox")).toBeChecked();
  await expect(article.getByRole("cell", { name: "Playwright" })).toBeVisible();
  await expect(article.getByText("ts", { exact: true })).toBeVisible();
  await expect(article.getByRole("link", { name: "Datasets" })).toHaveAttribute("href", "/wiki#datasets");
  await expect(article.getByRole("link", { name: "Medical Text Dataset Downloads" })).toHaveAttribute(
    "href",
    "/wiki#medical-text-dataset-downloads"
  );
  await expect(article.getByRole("link", { name: "Dataset Tokenization Canary Attempt 2026-04-27" })).toHaveAttribute(
    "href",
    "/wiki#dataset-tokenization-canary-attempt-2026-04-27"
  );
  await expect(article.getByRole("link", { name: "the operating manual" })).toHaveAttribute(
    "href",
    "/wiki#agent-operating-manual"
  );
  await expect(article.locator("code").filter({ hasText: "[[Do Not Link]]" })).toBeVisible();

  const response = await page.request.get(`/api/v1/wiki/pages/${slugFromTitle(title)}`);
  await expectApiOk(response, "load saved wiki page");
  const savedPage = (await response.json()) as { title?: string; body_markdown?: string };
  expect(savedPage.title).toBe(title);
  expect(savedPage.body_markdown).toContain(marker);
});

test("run builder creates a backend Codex command plan", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Run Builder Planner");

  await openRoute(page, "/run-builder");
  await expectBackendOnline(page);
  await expect(page.getByLabel("Agent", { exact: true })).toContainText(agent.name);

  await page.getByLabel("Workspace Override").fill("/tmp/fake-workspace");
  await page.getByLabel("Prompt", { exact: true }).fill("Prepare a concise smoke-test run plan for backend verification.");
  await page.getByRole("button", { name: "Create Plan" }).click();

  await expect(page.getByText("Run plan created. Backend returned a Codex command plan; execution is not wired yet.")).toBeVisible();
  await expect(page.getByText("Plan ready")).toBeVisible();
  await expect(page.getByText("gpt-5.5").first()).toBeVisible();
  await expect(page.getByText("high").first()).toBeVisible();
  await expect(page.locator("pre").filter({ hasText: "exec --json" })).toBeVisible();
});

test("Tab queues the mission composer through the run API", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Tab Queue Agent");
  const conversationId = `dm_${agent.id}`;
  const prompt = `Queue from Tab ${uniqueSuffix()}`;

  await mockDmMessageCreate(page, conversationId);
  await openAgentDm(page, agent);
  const requestPromise = page.waitForRequest((request) => {
    return request.method() === "POST" && request.url().endsWith(`/api/v1/conversations/${conversationId}/messages`);
  });

  const composer = page.getByPlaceholder("Message room or assign agent...");
  await composer.fill(prompt);
  await composer.press("Tab");
  const queued = requestBody(await requestPromise);

  expect(queued).toMatchObject({
    author_kind: "human",
    author_id: "owner",
    body: prompt,
    delivery_mode: "queue",
  });
  await expect(composer).toHaveValue("");
});

test("Enter submits the mission composer as an urgent run", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Enter Urgent Agent");
  const conversationId = `dm_${agent.id}`;
  const prompt = `Urgent from Enter ${uniqueSuffix()}`;

  await mockDmMessageCreate(page, conversationId);
  await openAgentDm(page, agent);
  const requestPromise = page.waitForRequest((request) => {
    return request.method() === "POST" && request.url().endsWith(`/api/v1/conversations/${conversationId}/messages`);
  });

  const composer = page.getByPlaceholder("Message room or assign agent...");
  await composer.fill(prompt);
  await composer.press("Enter");
  const urgent = requestBody(await requestPromise);

  expect(urgent).toMatchObject({
    author_kind: "human",
    author_id: "owner",
    body: prompt,
    delivery_mode: "urgent",
  });
  await expect(composer).toHaveValue("");
});

test("DM transcript refreshes with agent replies without switching conversations", async ({ page }) => {
  await installFastCodex(page);
  const agent = await createSmokeAgent(page, "Live Refresh Agent");
  const prompt = `Live refresh prompt ${uniqueSuffix()}`;

  await openAgentDm(page, agent);
  const composer = page.getByPlaceholder("Message room or assign agent...");
  await composer.fill(prompt);
  await composer.press("Enter");

  await expect(page.locator("article").filter({ hasText: prompt })).toBeVisible();
  await expect(page.getByText("fast codex complete").first()).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`#dm_${escapeRegExp(agent.id)}$`));
});

test("Shift+Enter keeps a newline in the mission composer draft", async ({ page }) => {
  await openRoute(page, "/");
  await expectBackendOnline(page);

  const composer = page.getByPlaceholder("Message room or assign agent...");
  await composer.click();
  await composer.pressSequentially("First line");
  await composer.press("Shift+Enter");
  await composer.pressSequentially("Second line");

  await expect(composer).toHaveValue("First line\nSecond line");
});

test("Stop interrupts the active run through the cancel endpoint", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Stop Runtime Agent");
  const conversationId = `dm_${agent.id}`;
  const runId = `run-${uniqueSuffix()}`;
  const run = fakeRun(runId, agent, conversationId, "running", "Stop smoke active run");

  await mockDmRuns(page, conversationId, [run]);
  await mockRunEvents(page, runId, []);
  await openAgentDm(page, agent);
  const requestPromise = page.waitForRequest((request) => {
    return request.method() === "POST" && request.url().endsWith(`/api/v1/conversations/${conversationId}/agent/stop`);
  });
  await page.route(`**/api/v1/conversations/${conversationId}/agent/stop`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ interrupted: true, run_id: runId }),
    });
  });

  const stopButton = page.getByRole("button", { name: "Stop", exact: true });
  await expect(stopButton).toBeEnabled();
  await stopButton.click();

  await requestPromise;
});

test("trace expansion loads run events for the selected run", async ({ page }) => {
  const agent = await createSmokeAgent(page, "Trace Runtime Agent");
  const conversationId = `dm_${agent.id}`;
  const runId = `run-${uniqueSuffix()}`;
  const taskSummary = "Trace smoke active run";
  const eventSummary = "runtime started";
  const repeatedSystemPrompt = [
    "You are working inside Agent Adda. Treat this as your effective system and task prompt for this run.",
    "",
    "Stored agent system prompt:",
    "You are Trace Runtime Agent. Role: Planner. Created by the Playwright backend smoke suite.",
    "",
    "The wiki is the company's shared memory. Before starting work, search and read the relevant wiki pages. While working, link to wiki pages when they explain a decision. After completing work, update the wiki with durable facts, decisions, architecture changes, runbooks, and open questions. If no durable knowledge changed, explicitly say so in your run summary.",
    "",
    "Agent Adda communication protocol:",
    "- DMs to agents are posted into that agent's DM and queued as a new Codex task for that agent.",
    "",
    "Agent roster:",
    "- Trace Runtime Agent (you): role=Planner, id=agent_trace, slug=trace-runtime-agent, dm=dm_agent_trace",
    "",
    "Latest assigned task:",
    eventSummary,
  ].join("\n");
  const promptSummary = repeatedSystemPrompt.replace(eventSummary, taskSummary);
  const run = fakeRun(runId, agent, conversationId, "running", promptSummary);

  await mockDmRuns(page, conversationId, [run]);
  await mockRunEvents(page, runId, [
    {
      id: `event-${uniqueSuffix()}`,
      run_id: runId,
      event_type: "run.started",
      payload: { status: "running", prompt_summary: promptSummary, detail: { message: repeatedSystemPrompt } },
      created_at: "2026-04-26 12:02:00",
    },
  ]);
  const requestPromise = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return request.method() === "GET" && url.pathname.endsWith(`/api/v1/runs/${runId}/events`);
  });

  await openAgentDm(page, agent);
  const eventsRequest = await requestPromise;
  expect(new URL(eventsRequest.url()).searchParams.get("limit")).toBe("80");

  await expect(page.getByText("Treat this as your effective system and task prompt")).toHaveCount(0);

  const details = page.locator("aside details").filter({ hasText: taskSummary }).last();
  await expect(details).toBeVisible();
  await expect(details.getByText(eventSummary)).toBeHidden();
  await details.locator("summary").click();
  await expect(details.getByText("Started")).toBeVisible();
  await expect(details.getByText(eventSummary)).toBeVisible();
  await expect(details.getByText("You are working inside Agent Adda")).toHaveCount(0);
  await expect(details.getByText("Stored agent system prompt")).toHaveCount(0);
  await expect(details.getByText("You are Trace Runtime Agent")).toHaveCount(0);
  await expect(details.getByText("The wiki is the company's shared memory")).toHaveCount(0);
});

for (const viewport of viewports) {
  test(`main routes have no obvious text overlap at ${viewport.name} size`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    for (const route of routes) {
      await route.prepare?.(page);
      await openRoute(page, route.path);
      await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
      await route.ready(page);
      await expectNoObviousTextOverlap(page);
    }
  });
}

async function openRoute(
  page: Page,
  path: string,
  options: { dismissStartupWizard?: boolean } = {}
) {
  const shouldDismissStartupWizard = options.dismissStartupWizard ?? true;
  const initializedBeforeNavigation = shouldDismissStartupWizard
    ? await onboardingInitialized(page)
    : true;

  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");

  if (shouldDismissStartupWizard && initializedBeforeNavigation !== true) {
    await dismissStartupWizardIfVisible(page);
  }
}

async function dismissStartupWizardIfVisible(page: Page) {
  const dialog = page.getByRole("dialog", { name: /First-Run Onboarding/i });
  await dialog.waitFor({ state: "visible", timeout: 3000 }).catch(() => null);

  if (!(await dialog.isVisible())) {
    return;
  }

  await dialog.getByRole("button", { name: "Close onboarding" }).click();
  await expect(dialog).toBeHidden();
}

async function onboardingInitialized(page: Page): Promise<boolean | null> {
  try {
    const response = await page.request.get("/api/v1/onboarding/status");
    if (!response.ok()) {
      return null;
    }
    const status = (await response.json()) as { initialized?: boolean };
    return status.initialized === true;
  } catch {
    return null;
  }
}

async function expectBackendOnline(page: Page) {
  const response = await page.request.get("/api/v1/health");
  await expectApiOk(response, "check backend health");
  await expectNoBackendFallback(page);
}

async function expectNoBackendFallback(page: Page) {
  await expect(page.getByText(/API unavailable|Backend unavailable|Demo data|Demo memory fallback/i)).toHaveCount(0);
}

async function ensureOperatingManualWiki(page: Page) {
  const existing = await page.request.get("/api/v1/wiki/pages/agent-operating-manual");
  if (existing.ok()) {
    return;
  }
  if (existing.status() !== 404) {
    await expectApiOk(existing, "load operating manual wiki page");
  }

  const response = await page.request.post("/api/v1/wiki/pages", {
    data: {
      title: "Agent Operating Manual",
      body_markdown: [
        "# Agent Operating Manual",
        "",
        "Before starting work, search and read relevant wiki pages.",
        "",
        "Durable knowledge belongs in the wiki, and durable knowledge should be cited when it changes.",
        "",
        "Use DMs for owner-agent work and channels for shared coordination.",
      ].join("\n"),
      updated_by: "system",
      change_summary: "Seeded operating manual for smoke tests",
    },
  });
  await expectApiOk(response, "create operating manual wiki page");
}

async function createSmokeAgent(page: Page, label: string): Promise<{ id: string; name: string }> {
  const name = `${label} ${uniqueSuffix()}`;
  const response = await page.request.post("/api/v1/agents", {
    data: {
      name,
      role: "Planner",
      description: "Created by the Playwright backend smoke suite.",
    },
  });
  await expectApiOk(response, `create ${name}`);

  return (await response.json()) as { id: string; name: string };
}

async function installFastCodex(page: Page) {
  const fakeCodexPath = new URL("./fixtures/fast-codex.sh", import.meta.url).pathname;
  await upsertSetting(page, "codex_binary_path", fakeCodexPath);
  await upsertSetting(page, "codex_bin", fakeCodexPath);
}

async function upsertSetting(page: Page, key: string, value: string) {
  const response = await page.request.post("/api/v1/settings", {
    data: { key, value },
  });
  await expectApiOk(response, `upsert setting ${key}`);
}

async function openAgentDm(page: Page, agent: { id: string; name: string }) {
  await openRoute(page, "/");
  await expectBackendOnline(page);
  await page.getByRole("button", { name: agent.name, exact: true }).click();
  await expect(page.getByText(`Direct message with ${agent.name}`).first()).toBeVisible();
}

async function mockDmMessageCreate(page: Page, conversationId: string) {
  await page.route(`**/api/v1/conversations/${conversationId}/messages`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }

    const body = requestBody(route.request());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: `message-${uniqueSuffix()}`,
        conversation_id: conversationId,
        author_kind: "human",
        author_id: "owner",
        body: String(body.body ?? ""),
        run_id: null,
        created_at: "2026-04-26 12:01:00",
      }),
    });
  });
}

async function mockDmRuns(
  page: Page,
  conversationId: string,
  runs: Array<Record<string, unknown>>,
) {
  await page.route("**/api/v1/runs?**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("conversation_id") !== conversationId) {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runs),
    });
  });
}

async function mockRunEvents(
  page: Page,
  runId: string,
  events: Array<Record<string, unknown>>,
) {
  await page.route(`**/api/v1/runs/${runId}/events**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(events),
    });
  });
}

async function mockOnboardingStatus(page: Page, initialized: boolean) {
  await page.route("**/api/v1/onboarding/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        initialized,
        completed: initialized,
        project_name: initialized ? "Initialized Smoke Project" : "",
        project_summary: initialized ? "Initialized smoke workspace" : "",
        workspace_path: "/tmp",
        default_model: "gpt-5.5",
        default_reasoning_effort: "high",
        agent_count: initialized ? 4 : 0,
        queued_ceo_task_runs: 0,
        queued_ceo_tasks: 0,
      }),
    });
  });
}

async function mockStatsDashboard(page: Page) {
  await page.route("**/api/v1/stats/summary", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        input_tokens: 12300,
        output_tokens: 4560,
        total_tokens: 18900,
        chatgpt_quota_used: 3400,
        chatgpt_quota_total: 10000,
        tasks_in_flight: 3,
        active_runs: 2,
        queued_runs: 1,
        pull_requests_merged: 7,
        employees: 4,
      }),
    });
  });

  await page.route("**/api/v1/stats/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          agent_id: "agent_metrics",
          name: "Metrics Engineer",
          status: "working",
          input_tokens: 12300,
          cached_input_tokens: 1200,
          output_tokens: 4560,
          reasoning_tokens: 2040,
          total_tokens: 18900,
          run_count: 9,
          pull_requests: 8,
          merged_pull_requests: 7,
          reviews: 5,
        },
      ]),
    });
  });

  await page.route("**/api/v1/stats/runs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { status: "running", count: 2 },
        { status: "queued", count: 1 },
        { status: "completed", count: 6 },
      ]),
    });
  });

  await page.route("**/api/v1/stats/tokens", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          agent_id: "agent_metrics",
          agent_name: "Metrics Engineer",
          model: "gpt-5.5",
          input_tokens: 12300,
          cached_input_tokens: 1200,
          output_tokens: 4560,
          reasoning_tokens: 2040,
          total_tokens: 18900,
        },
      ]),
    });
  });

  await page.route("**/api/v1/stats/prs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { agent_id: "agent_metrics", agent_name: "Metrics Engineer", status: "merged", count: 7 },
        { agent_id: "agent_metrics", agent_name: "Metrics Engineer", status: "open", count: 1 },
      ]),
    });
  });

  await page.route("**/api/v1/stats/reviews", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { agent_id: "agent_metrics", agent_name: "Metrics Engineer", decision: "approved", count: 5 },
      ]),
    });
  });

  await page.route("**/api/v1/stats/employees-over-time", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { period: "2026-04-24", hired_count: 1, employee_count: 1 },
        { period: "2026-04-25", hired_count: 3, employee_count: 4 },
      ]),
    });
  });
}

async function mockRunningDmSidebar(page: Page): Promise<{
  agent: { id: string; name: string };
  otherAgent: { id: string; name: string };
}> {
  const agent = {
    id: "agent_running_sidebar",
    name: "Running Sidebar Agent",
    slug: "running-sidebar-agent",
    role: "Engineer",
    description: "Agent with a selected running DM run.",
    profile: "",
    system_prompt: "",
    status: "idle",
    model: "gpt-5.5",
    reasoning_effort: "high",
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    deleted_at: null,
  };
  const otherAgent = {
    id: "agent_idle_sidebar",
    name: "Idle Sidebar Agent",
    slug: "idle-sidebar-agent",
    role: "Engineer",
    description: "Agent used to prove sidebar run status is not tied to focus.",
    profile: "",
    system_prompt: "",
    status: "idle",
    model: "gpt-5.5",
    reasoning_effort: "high",
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    deleted_at: null,
  };
  const dmId = `dm_${agent.id}`;
  const otherDmId = `dm_${otherAgent.id}`;
  const runId = "run_running_sidebar";
  const runningRun = fakeRun(runId, agent, dmId, "running", "Compile the status dashboard");

  await page.route("**/api/v1/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([agent, otherAgent]),
    });
  });

  await page.route("**/api/v1/conversations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "channel_launch",
          kind: "channel",
          name: "launch-room",
          slug: "launch-room",
          topic: "Launch coordination",
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
        {
          id: dmId,
          kind: "dm",
          name: agent.name,
          slug: agent.slug,
          topic: `Direct message with ${agent.name}`,
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
        {
          id: otherDmId,
          kind: "dm",
          name: otherAgent.name,
          slug: otherAgent.slug,
          topic: `Direct message with ${otherAgent.name}`,
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
      ]),
    });
  });

  await page.route("**/api/v1/conversations/*/messages**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/v1/runs?**", async (route) => {
    const url = new URL(route.request().url());
    const conversationId = url.searchParams.get("conversation_id");
    if (!conversationId || conversationId === dmId) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([runningRun]),
      });
      return;
    }
    if (conversationId === otherDmId) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }

    await route.fallback();
  });
  await mockRunEvents(page, runId, [
    {
      id: "event_running_sidebar",
      run_id: runId,
      event_type: "run.started",
      payload_json: JSON.stringify({ from_status: "queued", to_status: "running" }),
      created_at: "2026-04-26 12:01:00",
    },
  ]);

  return { agent, otherAgent };
}

async function mockStaleWorkingDmSidebar(page: Page): Promise<{ id: string; name: string }> {
  const agent = {
    id: "agent_stale_working_sidebar",
    name: "Dataset Wizard",
    slug: "dataset-wizard",
    role: "Agent",
    description: "Agent with an old working snapshot but no active run.",
    profile: "",
    system_prompt: "",
    status: "working",
    model: "gpt-5.5",
    reasoning_effort: "high",
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    deleted_at: null,
  };
  const dmId = `dm_${agent.id}`;

  await page.route("**/api/v1/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([agent]),
    });
  });

  await page.route("**/api/v1/conversations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: dmId,
          kind: "dm",
          name: agent.name,
          slug: agent.slug,
          topic: `Direct message with ${agent.name}`,
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
      ]),
    });
  });

  await page.route("**/api/v1/conversations/*/messages**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route("**/api/v1/runs?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  return agent;
}

async function mockLongDmTranscript(page: Page): Promise<{ id: string; name: string }> {
  const agent = {
    id: "agent_long_dm",
    name: "Long DM Agent",
    slug: "long-dm-agent",
    role: "Engineer",
    description: "Agent with enough messages to require transcript scrolling.",
    profile: "",
    system_prompt: "",
    status: "idle",
    model: "gpt-5.5",
    reasoning_effort: "high",
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    deleted_at: null,
  };
  const dmId = `dm_${agent.id}`;
  const messages = Array.from({ length: 44 }, (_, index) => {
    const isLatest = index === 43;
    return {
      id: `long-dm-message-${index}`,
      conversation_id: dmId,
      author_kind: index % 2 === 0 ? "human" : "agent",
      author_id: index % 2 === 0 ? "owner" : agent.id,
      body: isLatest
        ? "Latest mocked DM message"
        : `Historical mocked DM message ${index + 1}\nDetails for scroll height ${index + 1}.`,
      run_id: null,
      created_at: `2026-04-26 12:${String(index).padStart(2, "0")}:00`,
    };
  });

  await page.route("**/api/v1/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([agent]),
    });
  });

  await page.route("**/api/v1/conversations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "channel_launch",
          kind: "channel",
          name: "launch-room",
          slug: "launch-room",
          topic: "Launch coordination",
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
        {
          id: dmId,
          kind: "dm",
          name: agent.name,
          slug: agent.slug,
          topic: `Direct message with ${agent.name}`,
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
      ]),
    });
  });

  await page.route("**/api/v1/conversations/*/messages**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(messages),
    });
  });

  await mockDmRuns(page, dmId, []);

  return agent;
}

async function mockDmTraceMessages(page: Page): Promise<{ id: string; name: string }> {
  const agent = {
    id: "agent_trace_dm",
    name: "Trace DM Agent",
    slug: "trace-dm-agent",
    role: "Engineer",
    description: "Agent with run-linked DM messages.",
    profile: "",
    system_prompt: "",
    status: "idle",
    model: "gpt-5.5",
    reasoning_effort: "high",
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    deleted_at: null,
  };
  const dmId = `dm_${agent.id}`;
  const dashboardReply = [
    "Dataset summary committed.",
    "",
    "Implemented the dashboard Linuxbrew PATH change.",
    "",
    "Changed files:",
    "- `Dockerfile`",
    "- `docker-compose.yml`",
    "- `architecture.md`",
    "",
    "Run this on the Docker host to finish verification:",
    "```bash",
    "docker compose up --build -d app-dashboard",
    "docker compose exec -T app-dashboard /bin/bash -lc 'which brew && brew --version'",
    "```",
    "",
    "```agent_adda.actions",
    JSON.stringify({
      actions: [
        {
          type: "wiki_upsert",
          title: "Dashboard Linuxbrew PATH",
          body_markdown: "# Dashboard Linuxbrew PATH\n\n```bash\ndocker compose up --build -d app-dashboard\n```\n",
          change_summary: "Documented dashboard Linuxbrew PATH behavior",
        },
      ],
    }),
    "```",
  ].join("\n");
  const messages = [
    {
      id: "trace-message-queued-request",
      conversation_id: dmId,
      author_kind: "human",
      author_id: "owner",
      body: "queue follow-up task",
      run_id: "run_trace_queued",
      created_at: "2026-04-26 11:59:30",
    },
    {
      id: "trace-message-running",
      conversation_id: dmId,
      author_kind: "human",
      author_id: "owner",
      body: "start dataset compilation",
      run_id: null,
      created_at: "2026-04-26 12:00:00",
    },
    {
      id: "trace-message-done-request",
      conversation_id: dmId,
      author_kind: "human",
      author_id: "owner",
      body: "compile summary",
      run_id: "run_trace_done",
      created_at: "2026-04-26 12:00:30",
    },
    {
      id: "trace-message-done",
      conversation_id: dmId,
      author_kind: "agent",
      author_id: agent.id,
      body: dashboardReply,
      run_id: "run_trace_done",
      created_at: "2026-04-26 12:01:00",
    },
    {
      id: "trace-message-error-request",
      conversation_id: dmId,
      author_kind: "human",
      author_id: "owner",
      body: "download external data",
      run_id: "run_trace_error",
      created_at: "2026-04-26 12:01:30",
    },
    {
      id: "trace-message-error",
      conversation_id: dmId,
      author_kind: "system",
      author_id: "system",
      body: "Run failed before producing a DM reply.",
      run_id: "run_trace_error",
      created_at: "2026-04-26 12:02:00",
    },
  ];

  await page.route("**/api/v1/agents", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([agent]),
    });
  });

  await page.route("**/api/v1/conversations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "channel_launch",
          kind: "channel",
          name: "launch-room",
          slug: "launch-room",
          topic: "Launch coordination",
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
        {
          id: dmId,
          kind: "dm",
          name: agent.name,
          slug: agent.slug,
          topic: `Direct message with ${agent.name}`,
          loop_enabled: 0,
          created_at: "2026-04-26 12:00:00",
          updated_at: "2026-04-26 12:00:00",
          archived_at: null,
        },
      ]),
    });
  });

  await page.route("**/api/v1/conversations/*/messages**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(messages),
    });
  });

  await mockDmRuns(page, dmId, [
    fakeRun("run_trace_queued", agent, dmId, "queued", "queue follow-up task"),
    fakeRun("run_trace_running", agent, dmId, "running", "start dataset compilation"),
    fakeRun("run_trace_done", agent, dmId, "completed", "compile summary"),
    fakeRun("run_trace_error", agent, dmId, "failed", "download external data"),
  ]);
  await mockRunEvents(page, "run_trace_queued", []);
  await mockRunEvents(page, "run_trace_running", [
    {
      id: "event_trace_start",
      run_id: "run_trace_running",
      event_type: "run.started",
      payload: { from_status: "queued", to_status: "running" },
      created_at: "2026-04-26 12:00:01",
    },
    {
      id: "event_trace_stdout_reasoning",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        event: {
          type: "event_msg",
          payload: {
            type: "agent_reasoning",
            message: "### Working notes\n- Inspecting dataset shards",
          },
        },
      },
      created_at: "2026-04-26 12:00:02",
    },
    {
      id: "event_trace_stdout_raw",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          thread_id: "019dd7e3-9154-7132-9f4d-5bbf4e36d085",
          type: "thread.started",
        }),
      },
      created_at: "2026-04-26 12:00:03",
    },
    {
      id: "event_trace_stdout_message",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          item: {
            id: "item_0",
            text: "Hi. I am here and ready for the next dataset task.\n\nNo durable wiki knowledge changed in this run.",
            type: "agent_message",
          },
          type: "item.completed",
        }),
      },
      created_at: "2026-04-26 12:00:04",
    },
    {
      id: "event_trace_stdout_usage",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          type: "turn.completed",
          usage: {
            cached_input_tokens: 6528,
            input_tokens: 34841,
            output_tokens: 232,
            reasoning_output_tokens: 204,
          },
        }),
      },
      created_at: "2026-04-26 12:00:05",
    },
    {
      id: "event_trace_stdout_plain",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: "plain stdout checkpoint",
      },
      created_at: "2026-04-26 12:00:06",
    },
    {
      id: "event_trace_stdout_empty_item_start",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          type: "item.started",
        }),
      },
      created_at: "2026-04-26 12:00:06",
    },
    {
      id: "event_trace_stdout_empty_command",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          item: {
            id: "item_8",
            type: "command_execution",
          },
          type: "item.completed",
        }),
      },
      created_at: "2026-04-26 12:00:06",
    },
    {
      id: "event_trace_stdout_command",
      run_id: "run_trace_running",
      event_type: "codex.stdout",
      payload: {
        stream: "stdout",
        line: JSON.stringify({
          item: {
            aggregated_output: "tokenized 207 visits\n",
            command: traceCommand,
            exit_code: 0,
            id: "item_7",
            status: "completed",
            type: "command_execution",
          },
          type: "item.completed",
        }),
      },
      created_at: "2026-04-26 12:00:06",
    },
    {
      id: "event_trace_ignored_stderr",
      run_id: "run_trace_running",
      event_type: "codex.stderr",
      payload: {
        stream: "stderr",
        line: "2026-04-27T06:59:52.158811Z ERROR codex_core::session: failed to record rollout items: thread 019dcd1b-2711-7161-ad05-de6553c2107e not found",
      },
      created_at: "2026-04-26 12:00:07",
    },
    {
      id: "event_trace_stderr",
      run_id: "run_trace_running",
      event_type: "codex.stderr",
      payload: {
        stream: "stderr",
        line: "stderr diagnostic checkpoint",
      },
      created_at: "2026-04-26 12:00:08",
    },
  ]);
  await mockRunEvents(page, "run_trace_done", []);
  await mockRunEvents(page, "run_trace_error", []);

  return agent;
}

function fakeRun(
  id: string,
  agent: { id: string; name: string },
  conversationId: string,
  status: string,
  promptSummary: string,
) {
  return {
    id,
    agent_id: agent.id,
    agent_name: agent.name,
    conversation_id: conversationId,
    status,
    trigger_kind: "owner-dm",
    prompt_hash: `hash-${id}`,
    prompt_summary: promptSummary,
    summary: "",
    model: "gpt-5.5",
    reasoning_effort: "high",
    branch: "",
    workspace: "/tmp",
    command: { program: "codex", args: ["exec"], stdin: promptSummary },
    queue_priority: 100,
    queued_by: "owner",
    started_at: "2026-04-26 12:00:00",
    ended_at: null,
    created_at: "2026-04-26 12:00:00",
    updated_at: "2026-04-26 12:00:00",
    event_count: 1,
  };
}

async function expectApiOk(
  response: { ok: () => boolean; status: () => number; text: () => Promise<string> },
  action: string,
) {
  if (response.ok()) {
    return;
  }

  throw new Error(`Backend API failed to ${action}: ${response.status()} ${await response.text()}`);
}

function uniqueSuffix(): string {
  return `${smokeRunId}-${Math.random().toString(36).slice(2, 8)}`;
}

function slugFromTitle(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setting(key: string, value: string) {
  return {
    key,
    value,
    updated_at: "2026-04-26 12:00:00",
  };
}

function check(check_key: string, label: string, status: string, detail: string) {
  return {
    check_key,
    label,
    status,
    detail,
    checked_at: "2026-04-26 12:00:00",
  };
}

function requestBody(request: { postDataJSON: () => unknown }): Record<string, unknown> {
  const body = request.postDataJSON();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Expected JSON object request body");
  }

  return body as Record<string, unknown>;
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return {
      innerWidth: window.innerWidth,
      scrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  });

  expect(overflow.scrollWidth, `document overflowed horizontally (body ${overflow.bodyScrollWidth}px, root ${overflow.scrollWidth}px, viewport ${overflow.innerWidth}px)`).toBeLessThanOrEqual(overflow.innerWidth);
}

async function expectFixedMobileViewport(page: Page) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const messageLog = document.querySelector("[data-aa-message-log]");
    return {
      bodyScrollHeight: body.scrollHeight,
      innerHeight: window.innerHeight,
      messageLogHeight: messageLog instanceof HTMLElement ? messageLog.clientHeight : 0,
      rootScrollHeight: root.scrollHeight,
    };
  });

  expect(metrics.rootScrollHeight, `mobile route should use internal scrolling, not document scroll (${metrics.rootScrollHeight}px > ${metrics.innerHeight}px)`).toBeLessThanOrEqual(metrics.innerHeight + 2);
  expect(metrics.bodyScrollHeight, `mobile body should fit viewport (${metrics.bodyScrollHeight}px > ${metrics.innerHeight}px)`).toBeLessThanOrEqual(metrics.innerHeight + 2);
  expect(metrics.messageLogHeight, "mobile chat transcript should keep most of the viewport").toBeGreaterThan(420);
}

function isMobileViewport(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1024) < 768;
}

async function expectNoObviousTextOverlap(page: Page) {
  const overlaps = await page.evaluate(() => {
    type TextBox = {
      text: string;
      owner: Element;
      left: number;
      top: number;
      right: number;
      bottom: number;
      width: number;
      height: number;
    };

    const boxes: TextBox[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (text.length < 2) return NodeFilter.FILTER_REJECT;

        const parent = node.parentElement;
        if (!parent || parent.closest("script, style, noscript, svg, [hidden], [aria-hidden='true'], .sr-only")) {
          return NodeFilter.FILTER_REJECT;
        }

        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const owner = node.parentElement;
      if (!owner) continue;

      const range = document.createRange();
      range.selectNodeContents(node);

      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 2 || rect.height < 7) continue;
        if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
          continue;
        }

        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(window.innerWidth, rect.right);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width < 2 || height < 7) continue;
        if (!isPaintedAtCenter(owner, left, top, right, bottom)) continue;

        boxes.push({
          text: node.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? "",
          owner,
          left,
          top,
          right,
          bottom,
          width,
          height,
        });
      }

      range.detach();
    }

    function describe(box: TextBox) {
      const id = box.owner.id ? `#${box.owner.id}` : "";
      const label = box.owner.getAttribute("aria-label") ?? "";
      const text = label || box.text;
      return `${box.owner.tagName.toLowerCase()}${id}: ${text}`;
    }

    function isPaintedAtCenter(owner: Element, left: number, top: number, right: number, bottom: number) {
      const x = Math.min(window.innerWidth - 1, Math.max(0, (left + right) / 2));
      const y = Math.min(window.innerHeight - 1, Math.max(0, (top + bottom) / 2));
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && (hit === owner || owner.contains(hit) || hit.contains(owner)));
    }

    const problems: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.owner === b.owner || a.owner.contains(b.owner) || b.owner.contains(a.owner)) continue;
        if (a.owner.closest("button,a") && a.owner.closest("button,a") === b.owner.closest("button,a")) continue;

        const overlapWidth = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapHeight = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapWidth <= 1 || overlapHeight <= 1) continue;

        const overlapArea = overlapWidth * overlapHeight;
        const minArea = Math.min(a.width * a.height, b.width * b.height);
        if (overlapArea < 18 || overlapArea / minArea < 0.25) continue;

        problems.push(`${describe(a)} overlaps ${describe(b)}`);
        if (problems.length >= 8) return problems;
      }
    }

    return problems;
  });

  expect(overlaps).toEqual([]);
}
