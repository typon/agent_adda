import { defineConfig, devices } from "@playwright/test";

const frontendPort = Number(process.env.AGENT_ADDA_PLAYWRIGHT_FRONTEND_PORT ?? 14321);
const backendPort = Number(process.env.AGENT_ADDA_PLAYWRIGHT_BACKEND_PORT ?? 18080);
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const backendUrl = `http://127.0.0.1:${backendPort}`;
const runId = process.env.AGENT_ADDA_PLAYWRIGHT_RUN_ID ?? `${Date.now()}-${process.pid}`;
const defaultDatabaseName = "agent_adda_playwright";
const postgresPort = process.env.AGENT_ADDA_POSTGRES_PORT ?? "15432";
const postgresBin = process.env.AGENT_ADDA_POSTGRES_BIN_DIR ?? "";
const postgresAdminUser = process.env.AGENT_ADDA_POSTGRES_ADMIN_USER ?? process.env.USER ?? "postgres";
const postgresTool = (name: string) => (postgresBin ? `${postgresBin}/${name}` : name);
const databaseUrl =
  process.env.AGENT_ADDA_PLAYWRIGHT_DATABASE_URL ??
  `postgres://agent_adda:agent_adda@127.0.0.1:${postgresPort}/${defaultDatabaseName}`;
const backendCommand = process.env.AGENT_ADDA_PLAYWRIGHT_DATABASE_URL
  ? "cargo run --manifest-path backend/Cargo.toml"
  : [
      `${postgresTool("dropdb")} --if-exists --force -h 127.0.0.1 -p ${postgresPort} -U ${postgresAdminUser} ${defaultDatabaseName}`,
      `${postgresTool("createdb")} -h 127.0.0.1 -p ${postgresPort} -U ${postgresAdminUser} -O agent_adda ${defaultDatabaseName}`,
      "cargo run --manifest-path backend/Cargo.toml"
    ].join(" && ");

export default defineConfig({
  testDir: "./frontend/tests",
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: frontendUrl,
    trace: "on-first-retry",
  },
  webServer: [
    {
      name: "backend",
      command: backendCommand,
      env: envWith({
        AGENT_ADDA_DATABASE_URL: databaseUrl,
        CC: "/usr/bin/cc",
        ROCKET_ADDRESS: "127.0.0.1",
        ROCKET_PORT: String(backendPort),
      }),
      url: `${backendUrl}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      name: "frontend",
      command: `../node_modules/.bin/astro dev --host 127.0.0.1 --port ${frontendPort}`,
      cwd: "frontend",
      env: envWith({
        AGENT_ADDA_BACKEND_TARGET: backendUrl,
      }),
      url: frontendUrl,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

function envWith(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return { ...env, ...extra };
}
