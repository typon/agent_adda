use crate::agent_communications::{
    AgentCommunicationAction, parse_agent_communications, post_agent_dm, post_channel_message,
    upsert_wiki_page_from_agent,
};
use crate::codex::{CodexCommandPlan, CodexRunRequest};
use crate::db::{Db, DbPool};
use crate::routes::runs::{QueueAgentRunInput, RUN_PRIORITY_NORMAL, queue_agent_run};
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{FromRow, Transaction};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::sync::mpsc::{Sender, channel};
use uuid::Uuid;

const SUPERVISOR_IDLE_SLEEP: Duration = Duration::from_secs(1);
const CODEX_STOP_POLL: Duration = Duration::from_millis(100);
const DEFAULT_GLOBAL_ACTIVE_RUNS: usize = 2;
const DEFAULT_PER_AGENT_ACTIVE_RUNS: usize = 1;
const MAX_ACTIVE_RUNS_SETTING: usize = 32;
const CODEX_LINE_CHANNEL_CAPACITY: usize = 256;
const MAX_RECORDED_CODEX_LINES: usize = 400;
const CODEX_CONTROLLER_ENV_KEYS: &[&str] = &["CODEX_THREAD_ID", "CODEX_CI"];
const CODEX_BWRAP_LOOPBACK_FAILURE: &str =
    "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
const SUPERVISOR_ERROR_RETRY_SLEEP: Duration = Duration::from_secs(1);

#[derive(Clone)]
pub struct RunSupervisor {
    notify: Arc<Notify>,
    stops: Arc<Mutex<HashMap<String, String>>>,
    active_runs: Arc<Mutex<HashMap<String, String>>>,
    health: Arc<Mutex<RuntimeHealthState>>,
}

pub enum StartQueuedRunResult {
    Started,
    NotQueued,
    AtCapacity,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeHealthSnapshot {
    pub status: String,
    pub issue: Option<String>,
    pub message: Option<String>,
    pub last_error_at: Option<String>,
    pub clearable: bool,
}

#[derive(Debug, Default)]
struct RuntimeHealthState {
    issue: Option<RuntimeHealthIssue>,
}

#[derive(Debug, Clone)]
struct RuntimeHealthIssue {
    kind: String,
    message: String,
    occurred_at: String,
}

#[derive(Debug, Clone, FromRow)]
struct QueueCandidate {
    id: String,
    agent_id: String,
}

#[derive(Debug, Clone, FromRow)]
struct RuntimeRun {
    id: String,
    agent_id: String,
    conversation_id: Option<String>,
    prompt: String,
    model: String,
    reasoning_effort: String,
    workspace: String,
    command_json: String,
}

#[derive(Debug)]
struct CodexLine {
    stream: &'static str,
    line: String,
}

#[derive(Debug)]
struct CodexProcessResult {
    success: bool,
    code: Option<i32>,
    stopped: bool,
    stop_reason: Option<String>,
}

impl RunSupervisor {
    pub fn new() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            stops: Arc::new(Mutex::new(HashMap::new())),
            active_runs: Arc::new(Mutex::new(HashMap::new())),
            health: Arc::new(Mutex::new(RuntimeHealthState::default())),
        }
    }

    pub fn wake(&self) {
        self.notify_queued();
    }

    pub fn notify_queued(&self) {
        self.notify.notify_one();
    }

    pub fn request_stop(&self, run_id: &str, reason: &str) {
        let mut stops = self
            .stops
            .lock()
            .expect("run stop map lock should not poison");
        stops.insert(run_id.to_string(), reason.to_string());
        self.notify.notify_waiters();
    }

    pub fn runtime_health(&self) -> RuntimeHealthSnapshot {
        let health = self
            .health
            .lock()
            .expect("runtime health lock should not poison");
        match health.issue.as_ref() {
            Some(issue) => RuntimeHealthSnapshot {
                status: "warning".to_string(),
                issue: Some(issue.kind.clone()),
                message: Some(issue.message.clone()),
                last_error_at: Some(issue.occurred_at.clone()),
                clearable: true,
            },
            None => RuntimeHealthSnapshot {
                status: "ok".to_string(),
                issue: None,
                message: None,
                last_error_at: None,
                clearable: false,
            },
        }
    }

    pub fn clear_runtime_health(&self) {
        let mut health = self
            .health
            .lock()
            .expect("runtime health lock should not poison");
        health.issue = None;
        self.notify.notify_waiters();
    }

    pub fn is_run_active(&self, run_id: &str) -> bool {
        let active_runs = self
            .active_runs
            .lock()
            .expect("active run map lock should not poison");
        active_runs.contains_key(run_id)
    }

    #[cfg(test)]
    fn mark_active(&self, agent_id: &str, run_id: &str) {
        let mut active_runs = self
            .active_runs
            .lock()
            .expect("active run map lock should not poison");
        active_runs.insert(run_id.to_string(), agent_id.to_string());
    }

    fn try_mark_active(
        &self,
        agent_id: &str,
        run_id: &str,
        global_limit: usize,
        per_agent_limit: usize,
    ) -> bool {
        let mut active_runs = self
            .active_runs
            .lock()
            .expect("active run map lock should not poison");
        if active_runs.contains_key(run_id) || active_runs.len() >= global_limit {
            return false;
        }

        let active_for_agent = active_runs
            .values()
            .filter(|active_agent| active_agent.as_str() == agent_id)
            .count();
        if active_for_agent >= per_agent_limit {
            return false;
        }

        active_runs.insert(run_id.to_string(), agent_id.to_string());
        true
    }

    fn clear_active(&self, agent_id: &str, run_id: &str) {
        let mut active_runs = self
            .active_runs
            .lock()
            .expect("active run map lock should not poison");
        if active_runs
            .get(run_id)
            .is_some_and(|active_agent| active_agent == agent_id)
        {
            active_runs.remove(run_id);
        }
    }

    fn stop_reason(&self, run_id: &str) -> Option<String> {
        let stops = self
            .stops
            .lock()
            .expect("run stop map lock should not poison");
        stops.get(run_id).cloned()
    }

    fn clear_stop(&self, run_id: &str) {
        let mut stops = self
            .stops
            .lock()
            .expect("run stop map lock should not poison");
        stops.remove(run_id);
    }

    async fn wait_for_signal(&self) {
        let _ = tokio::time::timeout(SUPERVISOR_IDLE_SLEEP, self.notify.notified()).await;
    }

    fn record_supervisor_error(&self, error: &sqlx::Error) {
        let kind = if is_database_locked_error(error) {
            "database_locked"
        } else {
            "run_supervisor_error"
        };
        let message = if kind == "database_locked" {
            "Database lock detected; queued runs may not start until the lock clears.".to_string()
        } else {
            format!("Run supervisor failed: {error}")
        };

        let mut health = self
            .health
            .lock()
            .expect("runtime health lock should not poison");
        health.issue = Some(RuntimeHealthIssue {
            kind: kind.to_string(),
            message,
            occurred_at: now_utc_timestamp(),
        });
    }
}

pub async fn supervise_runs(pool: DbPool, supervisor: RunSupervisor) {
    if let Err(error) = mark_orphaned_running_runs_failed(&pool).await {
        eprintln!("run supervisor startup recovery failed: {error}");
    }
    if let Err(error) = clear_sessions_after_sandbox_failures(&pool).await {
        eprintln!("run supervisor sandbox recovery failed: {error}");
    }

    loop {
        match start_queued_runs(&pool, &supervisor).await {
            Ok(0) => supervisor.wait_for_signal().await,
            Ok(_) => tokio::task::yield_now().await,
            Err(error) => {
                eprintln!("run supervisor loop failed: {error}");
                supervisor.record_supervisor_error(&error);
                tokio::time::sleep(SUPERVISOR_ERROR_RETRY_SLEEP).await;
            }
        }
    }
}

fn is_database_locked_error(error: &sqlx::Error) -> bool {
    match error {
        sqlx::Error::Database(database_error) => {
            database_error
                .code()
                .is_some_and(|code| matches!(code.as_ref(), "55P03" | "40P01"))
                || database_error.message().contains("lock")
        }
        _ => false,
    }
}

fn now_utc_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

async fn start_queued_runs(
    pool: &DbPool,
    supervisor: &RunSupervisor,
) -> Result<usize, sqlx::Error> {
    let global_limit =
        read_usize_setting(pool, "global_max_active_runs", DEFAULT_GLOBAL_ACTIVE_RUNS).await?;
    let per_agent_limit = read_usize_setting(
        pool,
        "per_agent_max_active_runs",
        DEFAULT_PER_AGENT_ACTIVE_RUNS,
    )
    .await?;

    let mut started = 0;
    loop {
        let global_running = running_count(pool).await?;
        if global_running >= global_limit {
            break;
        }

        let candidates = queue_candidates(pool, per_agent_limit).await?;
        if candidates.is_empty() {
            break;
        }

        let mut claimed_one = false;
        for candidate in candidates {
            let agent_running = running_count_for_agent(pool, &candidate.agent_id).await?;
            if agent_running >= per_agent_limit {
                continue;
            }

            if !supervisor.try_mark_active(
                &candidate.agent_id,
                &candidate.id,
                global_limit,
                per_agent_limit,
            ) {
                continue;
            }

            if let Some(run) = claim_run(pool, &candidate.id).await? {
                let run_pool = pool.clone();
                let run_supervisor = supervisor.clone();
                tokio::spawn(async move {
                    execute_run(run_pool, run_supervisor, run).await;
                });
                started += 1;
                claimed_one = true;
                break;
            } else {
                supervisor.clear_active(&candidate.agent_id, &candidate.id);
            }
        }

        if !claimed_one {
            break;
        }
    }

    Ok(started)
}

pub async fn start_queued_run_by_id(
    pool: DbPool,
    supervisor: RunSupervisor,
    run_id: &str,
) -> Result<StartQueuedRunResult, sqlx::Error> {
    let Some(agent_id) = sqlx::query_scalar::<_, String>(
        "SELECT agent_id FROM agent_runs WHERE id = $1 AND status = 'queued'",
    )
    .bind(run_id)
    .fetch_optional(&pool)
    .await?
    else {
        return Ok(StartQueuedRunResult::NotQueued);
    };

    let global_limit =
        read_usize_setting(&pool, "global_max_active_runs", DEFAULT_GLOBAL_ACTIVE_RUNS).await?;
    if running_count(&pool).await? >= global_limit {
        return Ok(StartQueuedRunResult::AtCapacity);
    }

    let per_agent_limit = read_usize_setting(
        &pool,
        "per_agent_max_active_runs",
        DEFAULT_PER_AGENT_ACTIVE_RUNS,
    )
    .await?;
    if running_count_for_agent(&pool, &agent_id).await? >= per_agent_limit {
        return Ok(StartQueuedRunResult::AtCapacity);
    }

    if !supervisor.try_mark_active(&agent_id, run_id, global_limit, per_agent_limit) {
        return Ok(StartQueuedRunResult::AtCapacity);
    }

    let Some(run) = claim_run(&pool, run_id).await? else {
        supervisor.clear_active(&agent_id, run_id);
        return Ok(StartQueuedRunResult::NotQueued);
    };

    tokio::spawn(async move {
        execute_run(pool, supervisor, run).await;
    });

    Ok(StartQueuedRunResult::Started)
}

async fn mark_orphaned_running_runs_failed(pool: &DbPool) -> Result<(), sqlx::Error> {
    let runs = sqlx::query_as::<_, RuntimeRun>(
        r#"
        SELECT id,
               agent_id,
               conversation_id,
               prompt,
               model,
               reasoning_effort,
               workspace,
               command_json
        FROM agent_runs
        WHERE status = 'running'
        ORDER BY started_at::timestamptz ASC, id ASC
        "#,
    )
    .fetch_all(pool)
    .await?;

    for run in runs {
        finish_failed(
            pool,
            &run,
            "Run was marked running but no backend worker owned it after startup.",
            json!({
                "recovered": true,
                "reason": "orphaned_running_run"
            }),
        )
        .await?;
    }

    Ok(())
}

async fn queue_candidates(
    pool: &DbPool,
    per_agent_limit: usize,
) -> Result<Vec<QueueCandidate>, sqlx::Error> {
    sqlx::query_as::<_, QueueCandidate>(
        r#"
        SELECT queued.id, queued.agent_id
        FROM agent_runs queued
        WHERE queued.status = 'queued'
          AND (
              SELECT COUNT(*)
              FROM agent_runs running
              WHERE running.agent_id = queued.agent_id
                AND running.status = 'running'
          ) < $1
        ORDER BY
            queued.queue_priority ASC,
            queued.created_at::timestamptz ASC,
            queued.id ASC
        LIMIT 32
        "#,
    )
    .bind(per_agent_limit as i64)
    .fetch_all(pool)
    .await
}

async fn claim_run(pool: &DbPool, run_id: &str) -> Result<Option<RuntimeRun>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let Some(run) = sqlx::query_as::<_, RuntimeRun>(
        r#"
        SELECT id,
               agent_id,
               conversation_id,
               prompt,
               model,
               reasoning_effort,
               workspace,
               command_json
        FROM agent_runs
        WHERE id = $1 AND status = 'queued'
        "#,
    )
    .bind(run_id)
    .fetch_optional(&mut *tx)
    .await?
    else {
        tx.commit().await?;
        return Ok(None);
    };

    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = 'running',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP::text),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $1 AND status = 'queued'
        "#,
    )
    .bind(run_id)
    .execute(&mut *tx)
    .await?;

    insert_run_event_in_tx(
        &mut tx,
        run_id,
        "run.started",
        json!({
            "from_status": "queued",
            "to_status": "running",
            "command": parse_json(&run.command_json)
        }),
    )
    .await?;

    sqlx::query(
        "UPDATE agents SET status = 'working', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
    )
    .bind(&run.agent_id)
    .execute(&mut *tx)
    .await?;

    set_agent_thread_active_in_tx(&mut tx, &run).await?;

    tx.commit().await?;
    Ok(Some(run))
}

async fn execute_run(pool: DbPool, supervisor: RunSupervisor, run: RuntimeRun) {
    let command = match command_plan_for_run(&pool, &run).await {
        Ok(command) => command,
        Err(error) => {
            let message = format!("failed to prepare Codex command: {error}");
            let end_result = finish_failed(
                &pool,
                &run,
                &message,
                json!({
                    "command_prepare_error": message
                }),
            )
            .await;
            supervisor.clear_stop(&run.id);
            supervisor.clear_active(&run.agent_id, &run.id);
            if let Err(error) = end_result {
                eprintln!("failed to finish run {}: {error}", run.id);
            }
            supervisor.notify_queued();
            return;
        }
    };
    let _ = insert_run_event(
        &pool,
        &run.id,
        "codex.launch",
        json!({
            "program": &command.program,
            "args": &command.args,
            "stdin_bytes": command.stdin.len()
        }),
    )
    .await;
    let codex_home = read_string_setting(&pool, "codex_home")
        .await
        .ok()
        .flatten();
    let (line_tx, mut line_rx) = channel::<CodexLine>(CODEX_LINE_CHANNEL_CAPACITY);
    let process_run_id = run.id.clone();
    let process_supervisor = supervisor.clone();
    let process = tokio::task::spawn_blocking(move || {
        run_codex_process(
            process_run_id,
            command,
            codex_home,
            process_supervisor,
            line_tx,
        )
    });
    tokio::pin!(process);

    let mut final_message = String::new();
    let mut last_stdout_line = String::new();
    let mut stderr_tail = String::new();
    let mut recorded_codex_lines = 0;
    let mut dropped_codex_lines = 0;
    let mut codex_session_id = read_agent_codex_session_id(&pool, &run.agent_id)
        .await
        .ok()
        .flatten();
    let process_result;

    loop {
        tokio::select! {
            Some(line) = line_rx.recv() => {
                update_run_context_from_codex_line(&pool, &run, &line, &mut codex_session_id).await;
                update_output_summary(&line, &mut final_message, &mut last_stdout_line, &mut stderr_tail);
                maybe_record_codex_line(
                    &pool,
                    &run.id,
                    line,
                    &mut recorded_codex_lines,
                    &mut dropped_codex_lines,
                ).await;
            }
            result = &mut process => {
                process_result = result;
                break;
            }
        }
    }

    while let Ok(line) = line_rx.try_recv() {
        update_run_context_from_codex_line(&pool, &run, &line, &mut codex_session_id).await;
        update_output_summary(
            &line,
            &mut final_message,
            &mut last_stdout_line,
            &mut stderr_tail,
        );
        maybe_record_codex_line(
            &pool,
            &run.id,
            line,
            &mut recorded_codex_lines,
            &mut dropped_codex_lines,
        )
        .await;
    }

    if dropped_codex_lines > 0 {
        let _ = insert_run_event(
            &pool,
            &run.id,
            "codex.output_truncated",
            json!({
                "recorded_lines": recorded_codex_lines,
                "dropped_lines": dropped_codex_lines
            }),
        )
        .await;
    }

    let end_result = match process_result {
        Ok(Ok(result)) => {
            let _ = insert_run_event(
                &pool,
                &run.id,
                "codex.exit",
                json!({
                    "success": result.success,
                    "code": result.code,
                    "stopped": result.stopped,
                    "stop_reason": result.stop_reason
                }),
            )
            .await;

            if result.stopped {
                finish_canceled(
                    &pool,
                    &run,
                    result
                        .stop_reason
                        .as_deref()
                        .unwrap_or("Run stopped by request."),
                    json!({ "interrupt": true }),
                )
                .await
            } else if result.success {
                if final_message.trim().is_empty() {
                    final_message = last_stdout_line.trim().to_string();
                }
                if final_message.trim().is_empty() {
                    final_message = "Codex completed without a final message.".to_string();
                }
                if is_codex_tool_sandbox_failure(&final_message) {
                    let clear_result =
                        clear_agent_codex_session(&pool, &run, "codex_tool_sandbox_failure").await;
                    if let Err(error) = clear_result {
                        eprintln!(
                            "failed to clear sandbox-broken session for agent {}: {error}",
                            run.agent_id
                        );
                    }
                    finish_failed(
                        &pool,
                        &run,
                        "Codex tool sandbox failed inside the agent session; cleared the stale session so the next run starts fresh without bubblewrap.",
                        json!({
                            "sandbox_failure": true,
                            "final_message": final_message
                        }),
                    )
                    .await
                } else {
                    finish_completed(&pool, &supervisor, &run, &final_message).await
                }
            } else {
                let error = exit_error_text(result.code, &stderr_tail);
                finish_failed(
                    &pool,
                    &run,
                    &error,
                    json!({
                        "exit_code": result.code,
                        "stderr_tail": stderr_tail
                    }),
                )
                .await
            }
        }
        Ok(Err(error)) => {
            finish_failed(
                &pool,
                &run,
                &error,
                json!({
                    "launch_error": error
                }),
            )
            .await
        }
        Err(error) => {
            let message = format!("Codex worker task failed: {error}");
            finish_failed(
                &pool,
                &run,
                &message,
                json!({
                    "join_error": message
                }),
            )
            .await
        }
    };

    supervisor.clear_stop(&run.id);
    supervisor.clear_active(&run.agent_id, &run.id);
    if let Err(error) = end_result {
        eprintln!("failed to finish run {}: {error}", run.id);
    }
    supervisor.notify_queued();
}

fn run_codex_process(
    run_id: String,
    command: CodexCommandPlan,
    codex_home: Option<String>,
    supervisor: RunSupervisor,
    line_tx: Sender<CodexLine>,
) -> Result<CodexProcessResult, String> {
    let mut process = Command::new(&command.program);
    process
        .args(&command.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    scrub_codex_controller_env(&mut process);
    if let Some(codex_home) = codex_home.as_deref() {
        process.env("CODEX_HOME", codex_home);
    }

    let mut child = process
        .spawn()
        .map_err(|error| format!("failed to launch {}: {error}", command.program))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(command.stdin.as_bytes())
            .map_err(|error| format!("failed to write Codex prompt: {error}"))?;
    }

    let mut reader_threads = Vec::with_capacity(2);
    if let Some(stdout) = child.stdout.take() {
        reader_threads.push(read_process_lines(stdout, "stdout", line_tx.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        reader_threads.push(read_process_lines(stderr, "stderr", line_tx));
    }

    let mut stopped = false;
    let mut stop_reason = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => return Err(format!("failed to poll Codex process: {error}")),
        }

        if !stopped {
            if let Some(reason) = supervisor.stop_reason(&run_id) {
                stopped = true;
                stop_reason = Some(reason);
                let _ = child.kill();
            }
        }

        thread::sleep(CODEX_STOP_POLL);
    };

    for reader_thread in reader_threads {
        let _ = reader_thread.join();
    }

    Ok(CodexProcessResult {
        success: status.success(),
        code: status.code(),
        stopped,
        stop_reason,
    })
}

fn read_process_lines<R: Read + Send + 'static>(
    reader: R,
    stream: &'static str,
    line_tx: Sender<CodexLine>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if stream == "stderr" && is_ignorable_codex_stderr(&line) {
                continue;
            }
            if line_tx.blocking_send(CodexLine { stream, line }).is_err() {
                break;
            }
        }
    })
}

fn scrub_codex_controller_env(process: &mut Command) {
    for key in CODEX_CONTROLLER_ENV_KEYS {
        process.env_remove(key);
    }
}

fn is_ignorable_codex_stderr(line: &str) -> bool {
    line.contains("ERROR codex_core::session: failed to record rollout items: thread ")
        && line.trim_end().ends_with(" not found")
}

fn update_output_summary(
    line: &CodexLine,
    final_message: &mut String,
    last_stdout_line: &mut String,
    stderr_tail: &mut String,
) {
    if line.stream == "stderr" {
        *stderr_tail = line.line.clone();
        return;
    }

    *last_stdout_line = line.line.clone();
    if let Ok(value) = serde_json::from_str::<Value>(&line.line) {
        if let Some(message) = extract_final_message(&value) {
            *final_message = message.to_string();
        }
    }
}

async fn command_plan_for_run(
    pool: &DbPool,
    run: &RuntimeRun,
) -> Result<CodexCommandPlan, sqlx::Error> {
    let codex_bin = command_program_for_run(run);
    let request = CodexRunRequest {
        agent_id: run.agent_id.clone(),
        workspace: run.workspace.clone().into(),
        prompt: run.prompt.clone(),
        model: run.model.clone(),
        reasoning_effort: run.reasoning_effort.clone(),
    };

    if let Some(session_id) = read_agent_codex_session_id(pool, &run.agent_id).await? {
        return Ok(request.resume_command_plan(&codex_bin, &session_id));
    }

    Ok(request.command_plan(&codex_bin))
}

fn command_program_for_run(run: &RuntimeRun) -> String {
    let value = parse_json(&run.command_json);
    let program = value
        .get("program")
        .and_then(Value::as_str)
        .filter(|program| !program.trim().is_empty());
    program
        .map(str::to_string)
        .unwrap_or_else(|| "codex".to_string())
}

fn extract_final_message(value: &Value) -> Option<&str> {
    if let Some(output) = value.get("final_output").and_then(Value::as_str) {
        return Some(output);
    }
    if let Some(output) = value.get("last_agent_message").and_then(Value::as_str) {
        return Some(output);
    }
    if value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| event_type == "item.completed")
    {
        let item = value.get("item")?;
        if item
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|item_type| item_type == "agent_message")
        {
            return item.get("text").and_then(Value::as_str);
        }
    }

    let payload = value.get("payload")?;
    match payload.get("type").and_then(Value::as_str) {
        Some("task_complete") => payload.get("last_agent_message").and_then(Value::as_str),
        Some("agent_message") => {
            if payload
                .get("phase")
                .and_then(Value::as_str)
                .is_some_and(|phase| phase == "final_answer")
            {
                payload.get("message").and_then(Value::as_str)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn extract_codex_session_id(value: &Value) -> Option<&str> {
    for object in [
        Some(value),
        value.get("payload"),
        value.get("item"),
        value.get("params"),
    ]
    .into_iter()
    .flatten()
    {
        for key in ["thread_id", "session_id"] {
            if let Some(id) = object.get(key).and_then(Value::as_str) {
                let id = id.trim();
                if is_codex_session_id(id) {
                    return Some(id);
                }
            }
        }
    }

    None
}

fn is_codex_session_id(value: &str) -> bool {
    let len = value.len();
    (8..=128).contains(&len)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_codex_compaction_event(value: &Value) -> bool {
    value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|event_type| event_type.contains("compact"))
        || value
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method == "thread/compacted")
}

async fn update_run_context_from_codex_line(
    pool: &DbPool,
    run: &RuntimeRun,
    line: &CodexLine,
    stored_session_id: &mut Option<String>,
) {
    if line.stream != "stdout" {
        return;
    }

    let Ok(value) = serde_json::from_str::<Value>(&line.line) else {
        return;
    };

    if let Some(session_id) = extract_codex_session_id(&value) {
        if stored_session_id.as_deref() != Some(session_id) {
            if let Err(error) = write_agent_codex_session_id(pool, run, session_id).await {
                eprintln!(
                    "failed to store codex session for run {} agent {}: {error}",
                    run.id, run.agent_id
                );
            } else {
                *stored_session_id = Some(session_id.to_string());
                let _ = insert_run_event(
                    pool,
                    &run.id,
                    "codex.thread_mapped",
                    json!({
                        "agent_id": &run.agent_id,
                        "codex_session_id": session_id
                    }),
                )
                .await;
            }
        }
    }

    if is_codex_compaction_event(&value) {
        let _ = insert_run_event(
            pool,
            &run.id,
            "codex.context_compacted",
            json!({
                "event": value
            }),
        )
        .await;
    }
}

async fn finish_completed(
    pool: &DbPool,
    supervisor: &RunSupervisor,
    run: &RuntimeRun,
    final_message: &str,
) -> Result<(), sqlx::Error> {
    let parsed_communications = parse_agent_communications(final_message);
    let visible_message = if parsed_communications.visible_message.trim().is_empty() {
        "Completed.".to_string()
    } else {
        parsed_communications.visible_message
    };
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = 'completed',
            summary = $1,
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP::text),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $2
        "#,
    )
    .bind(&visible_message)
    .bind(&run.id)
    .execute(&mut *tx)
    .await?;

    insert_run_event_in_tx(
        &mut tx,
        &run.id,
        "run.completed",
        json!({
            "from_status": "running",
            "to_status": "completed",
            "final_message": &visible_message,
            "communication_actions": parsed_communications.actions.len()
        }),
    )
    .await?;

    if let Some(conversation_id) = run.conversation_id.as_deref() {
        insert_message_in_tx(
            &mut tx,
            conversation_id,
            "agent",
            &run.agent_id,
            &visible_message,
            Some(&run.id),
        )
        .await?;
    }

    clear_agent_thread_active_in_tx(&mut tx, run).await?;
    sync_agent_runtime_status(&mut tx, &run.agent_id).await?;
    tx.commit().await?;

    let report = apply_agent_communications(
        pool,
        supervisor,
        run,
        parsed_communications.actions,
        parsed_communications.errors,
    )
    .await;
    if report.has_activity() {
        let _ = insert_run_event(pool, &run.id, "agent.communication_applied", json!(report)).await;
    }

    Ok(())
}

#[derive(Debug, Default, Serialize)]
struct AgentCommunicationReport {
    dm_posts: usize,
    channel_posts: usize,
    wiki_upserts: usize,
    queued_runs: usize,
    errors: Vec<String>,
}

impl AgentCommunicationReport {
    fn has_activity(&self) -> bool {
        self.dm_posts > 0
            || self.channel_posts > 0
            || self.wiki_upserts > 0
            || self.queued_runs > 0
            || !self.errors.is_empty()
    }
}

async fn apply_agent_communications(
    pool: &DbPool,
    supervisor: &RunSupervisor,
    run: &RuntimeRun,
    actions: Vec<AgentCommunicationAction>,
    parse_errors: Vec<String>,
) -> AgentCommunicationReport {
    let mut report = AgentCommunicationReport {
        errors: parse_errors,
        ..AgentCommunicationReport::default()
    };

    for action in actions {
        match action {
            AgentCommunicationAction::Dm { to_agent, body } => {
                match post_agent_dm(pool, &run.agent_id, &run.id, &to_agent, &body).await {
                    Ok(delivery) => {
                        report.dm_posts += 1;
                        match queue_agent_run(
                            pool,
                            QueueAgentRunInput {
                                agent_id: delivery.target_agent_id,
                                prompt: delivery.body,
                                workspace: None,
                                conversation_id: Some(delivery.conversation_id),
                                trigger_kind: "agent-dm".to_string(),
                                branch: String::new(),
                                queue_priority: RUN_PRIORITY_NORMAL,
                                queued_by: run.agent_id.clone(),
                            },
                        )
                        .await
                        {
                            Ok(queued) => {
                                if let Err(error) = link_message_to_run(
                                    pool,
                                    &delivery.message_id,
                                    &queued.run.id,
                                )
                                .await
                                {
                                    report.errors.push(format!(
                                        "failed to link DM message to queued run for {to_agent}: {error}"
                                    ));
                                }
                                report.queued_runs += 1;
                                supervisor.notify_queued();
                            }
                            Err(status) => report
                                .errors
                                .push(format!("failed to queue DM run for {to_agent}: {status:?}")),
                        }
                    }
                    Err(error) => report
                        .errors
                        .push(format!("failed to send DM to {to_agent}: {error}")),
                }
            }
            AgentCommunicationAction::ChannelPost { to_channel, body } => {
                match post_channel_message(pool, &run.agent_id, &run.id, &to_channel, &body).await {
                    Ok(()) => report.channel_posts += 1,
                    Err(error) => report
                        .errors
                        .push(format!("failed to post to channel {to_channel}: {error}")),
                }
            }
            AgentCommunicationAction::WikiUpsert {
                title,
                body_markdown,
                change_summary,
            } => {
                match upsert_wiki_page_from_agent(
                    pool,
                    &run.agent_id,
                    &run.id,
                    &title,
                    &body_markdown,
                    change_summary.as_deref(),
                )
                .await
                {
                    Ok(()) => report.wiki_upserts += 1,
                    Err(error) => report
                        .errors
                        .push(format!("failed to upsert wiki page {title}: {error}")),
                }
            }
        }
    }

    report
}

async fn link_message_to_run(
    pool: &DbPool,
    message_id: &str,
    run_id: &str,
) -> Result<(), sqlx::Error> {
    let result = sqlx::query("UPDATE messages SET run_id = $1 WHERE id = $2")
        .bind(run_id)
        .bind(message_id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(sqlx::Error::RowNotFound);
    }
    Ok(())
}

async fn finish_failed(
    pool: &DbPool,
    run: &RuntimeRun,
    error: &str,
    detail: Value,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = 'failed',
            summary = $1,
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP::text),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $2
        "#,
    )
    .bind(error)
    .bind(&run.id)
    .execute(&mut *tx)
    .await?;

    insert_run_event_in_tx(
        &mut tx,
        &run.id,
        "run.failed",
        json!({
            "from_status": "running",
            "to_status": "failed",
            "error": error,
            "detail": detail
        }),
    )
    .await?;

    if let Some(conversation_id) = run.conversation_id.as_deref() {
        let body = format!(
            "**Run failed**\n\nRun `{}` failed before producing a DM reply.\n\nReason: {}",
            run.id, error
        );
        insert_message_in_tx(
            &mut tx,
            conversation_id,
            "system",
            "system",
            &body,
            Some(&run.id),
        )
        .await?;
    }

    clear_agent_thread_active_in_tx(&mut tx, run).await?;
    sync_agent_runtime_status(&mut tx, &run.agent_id).await?;
    tx.commit().await
}

async fn finish_canceled(
    pool: &DbPool,
    run: &RuntimeRun,
    reason: &str,
    detail: Value,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE agent_runs
        SET status = 'canceled',
            summary = $1,
            ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP::text),
            updated_at = CURRENT_TIMESTAMP::text
        WHERE id = $2
        "#,
    )
    .bind(reason)
    .bind(&run.id)
    .execute(&mut *tx)
    .await?;

    insert_run_event_in_tx(
        &mut tx,
        &run.id,
        "run.canceled",
        json!({
            "from_status": "running",
            "to_status": "canceled",
            "reason": reason,
            "detail": detail
        }),
    )
    .await?;

    clear_agent_thread_active_in_tx(&mut tx, run).await?;
    sync_agent_runtime_status(&mut tx, &run.agent_id).await?;
    tx.commit().await
}

async fn record_codex_line(
    pool: &DbPool,
    run_id: &str,
    line: CodexLine,
) -> Result<(), sqlx::Error> {
    let payload = match serde_json::from_str::<Value>(&line.line) {
        Ok(value) => json!({
            "stream": line.stream,
            "event": value
        }),
        Err(_) => json!({
            "stream": line.stream,
            "line": line.line
        }),
    };
    let event_type = if line.stream == "stdout" {
        "codex.stdout"
    } else {
        "codex.stderr"
    };
    insert_run_event(pool, run_id, event_type, payload).await
}

async fn maybe_record_codex_line(
    pool: &DbPool,
    run_id: &str,
    line: CodexLine,
    recorded_lines: &mut usize,
    dropped_lines: &mut usize,
) {
    if *recorded_lines >= MAX_RECORDED_CODEX_LINES {
        *dropped_lines += 1;
        return;
    }

    *recorded_lines += 1;
    if let Err(error) = record_codex_line(pool, run_id, line).await {
        eprintln!("failed to record codex output for run {run_id}: {error}");
    }
}

async fn insert_run_event(
    pool: &DbPool,
    run_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<(), sqlx::Error> {
    let payload_json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    sqlx::query(
        r#"
        INSERT INTO run_events (id, run_id, event_type, payload_json)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(run_id)
    .bind(event_type)
    .bind(payload_json)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_run_event_in_tx(
    tx: &mut Transaction<'_, Db>,
    run_id: &str,
    event_type: &str,
    payload: Value,
) -> Result<(), sqlx::Error> {
    let payload_json = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    sqlx::query(
        r#"
        INSERT INTO run_events (id, run_id, event_type, payload_json)
        VALUES ($1, $2, $3, $4)
        "#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(run_id)
    .bind(event_type)
    .bind(payload_json)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_message_in_tx(
    tx: &mut Transaction<'_, Db>,
    conversation_id: &str,
    author_kind: &str,
    author_id: &str,
    body: &str,
    run_id: Option<&str>,
) -> Result<(), sqlx::Error> {
    let message_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO messages (id, conversation_id, author_kind, author_id, body, run_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(author_kind)
    .bind(author_id)
    .bind(body)
    .bind(run_id)
    .execute(&mut **tx)
    .await?;

    let conversation_name =
        sqlx::query_scalar::<_, String>("SELECT name FROM conversations WHERE id = $1")
            .bind(conversation_id)
            .fetch_one(&mut **tx)
            .await?;
    let search_title = format!("Message in {conversation_name}");
    sqlx::query(
        r#"
        INSERT INTO search_index (entity_type, entity_id, title, body)
        VALUES ('message', $1, $2, $3)
        ON CONFLICT (entity_type, entity_id) DO UPDATE SET
            title = excluded.title,
            body = excluded.body
        "#,
    )
    .bind(&message_id)
    .bind(search_title)
    .bind(body)
    .execute(&mut **tx)
    .await?;

    sqlx::query("UPDATE conversations SET updated_at = CURRENT_TIMESTAMP::text WHERE id = $1")
        .bind(conversation_id)
        .execute(&mut **tx)
        .await?;

    Ok(())
}

async fn sync_agent_runtime_status(
    tx: &mut Transaction<'_, Db>,
    agent_id: &str,
) -> Result<(), sqlx::Error> {
    let running = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_runs WHERE agent_id = $1 AND status = 'running'",
    )
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;

    if running > 0 {
        sqlx::query(
            "UPDATE agents SET status = 'working', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
        )
        .bind(agent_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    let queued = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_runs WHERE agent_id = $1 AND status = 'queued'",
    )
    .bind(agent_id)
    .fetch_one(&mut **tx)
    .await?;

    if queued > 0 {
        sqlx::query(
            "UPDATE agents SET status = 'pending', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1",
        )
        .bind(agent_id)
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    sqlx::query(
        "UPDATE agents SET status = 'idle', updated_at = CURRENT_TIMESTAMP::text WHERE id = $1 AND status IN ('working', 'pending')",
    )
    .bind(agent_id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn set_agent_thread_active_in_tx(
    tx: &mut Transaction<'_, Db>,
    run: &RuntimeRun,
) -> Result<(), sqlx::Error> {
    let updated = sqlx::query(
        r#"
        UPDATE agent_threads
        SET active_run_id = $1,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE agent_id = $2
        "#,
    )
    .bind(&run.id)
    .bind(&run.agent_id)
    .execute(&mut **tx)
    .await?
    .rows_affected();

    if updated > 0 {
        return Ok(());
    }

    let Some(conversation_id) = dm_conversation_id_for_run_in_tx(tx, run).await? else {
        return Ok(());
    };

    sqlx::query(
        r#"
        INSERT INTO agent_threads (agent_id, conversation_id, active_run_id, updated_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP::text)
        ON CONFLICT(agent_id) DO UPDATE SET
            active_run_id = excluded.active_run_id,
            updated_at = CURRENT_TIMESTAMP::text
        "#,
    )
    .bind(&run.agent_id)
    .bind(conversation_id)
    .bind(&run.id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn clear_agent_thread_active_in_tx(
    tx: &mut Transaction<'_, Db>,
    run: &RuntimeRun,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_threads
        SET active_run_id = NULL,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE agent_id = $1 AND active_run_id = $2
        "#,
    )
    .bind(&run.agent_id)
    .bind(&run.id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn clear_sessions_after_sandbox_failures(pool: &DbPool) -> Result<(), sqlx::Error> {
    let failure_pattern = sandbox_failure_like_pattern();
    sqlx::query(
        r#"
        UPDATE agent_threads
        SET codex_session_id = '',
            updated_at = CURRENT_TIMESTAMP::text
        WHERE codex_session_id != ''
          AND (
              EXISTS (
                  SELECT 1
                  FROM agent_runs
                  WHERE agent_runs.agent_id = agent_threads.agent_id
                    AND agent_runs.summary LIKE $1
              )
              OR EXISTS (
                  SELECT 1
                  FROM agent_runs
                  JOIN run_events ON run_events.run_id = agent_runs.id
                  WHERE agent_runs.agent_id = agent_threads.agent_id
                    AND run_events.payload_json LIKE $2
              )
              OR EXISTS (
                  SELECT 1
                  FROM messages
                  WHERE messages.conversation_id = agent_threads.conversation_id
                    AND messages.body LIKE $3
              )
          )
        "#,
    )
    .bind(&failure_pattern)
    .bind(&failure_pattern)
    .bind(&failure_pattern)
    .execute(pool)
    .await?;

    Ok(())
}

async fn clear_agent_codex_session(
    pool: &DbPool,
    run: &RuntimeRun,
    reason: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        UPDATE agent_threads
        SET codex_session_id = '',
            updated_at = CURRENT_TIMESTAMP::text
        WHERE agent_id = $1
        "#,
    )
    .bind(&run.agent_id)
    .execute(pool)
    .await?;

    insert_run_event(
        pool,
        &run.id,
        "codex.session_cleared",
        json!({
            "agent_id": &run.agent_id,
            "reason": reason
        }),
    )
    .await?;

    Ok(())
}

fn sandbox_failure_like_pattern() -> String {
    format!("%{CODEX_BWRAP_LOOPBACK_FAILURE}%")
}

fn is_codex_tool_sandbox_failure(value: &str) -> bool {
    value.contains(CODEX_BWRAP_LOOPBACK_FAILURE)
}

async fn read_agent_codex_session_id(
    pool: &DbPool,
    agent_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT codex_session_id FROM agent_threads WHERE agent_id = $1",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;

    Ok(value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

async fn write_agent_codex_session_id(
    pool: &DbPool,
    run: &RuntimeRun,
    session_id: &str,
) -> Result<(), sqlx::Error> {
    let updated = sqlx::query(
        r#"
        UPDATE agent_threads
        SET active_run_id = $1,
            codex_session_id = $2,
            updated_at = CURRENT_TIMESTAMP::text
        WHERE agent_id = $3
        "#,
    )
    .bind(&run.id)
    .bind(session_id)
    .bind(&run.agent_id)
    .execute(pool)
    .await?
    .rows_affected();

    if updated == 0 {
        let Some(conversation_id) = dm_conversation_id_for_run(pool, run).await? else {
            return Ok(());
        };
        sqlx::query(
            r#"
            INSERT INTO agent_threads (
                agent_id,
                conversation_id,
                active_run_id,
                codex_session_id,
                updated_at
            )
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP::text)
            ON CONFLICT(agent_id) DO UPDATE SET
                active_run_id = excluded.active_run_id,
                codex_session_id = excluded.codex_session_id,
                updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .bind(&run.agent_id)
        .bind(conversation_id)
        .bind(&run.id)
        .bind(session_id)
        .execute(pool)
        .await?;
    }

    Ok(())
}

async fn dm_conversation_id_for_run_in_tx(
    tx: &mut Transaction<'_, Db>,
    run: &RuntimeRun,
) -> Result<Option<String>, sqlx::Error> {
    let Some(conversation_id) = run.conversation_id.as_deref() else {
        return Ok(None);
    };

    let kind = sqlx::query_scalar::<_, String>("SELECT kind FROM conversations WHERE id = $1")
        .bind(conversation_id)
        .fetch_optional(&mut **tx)
        .await?;

    Ok(kind
        .filter(|kind| kind == "dm")
        .map(|_| conversation_id.to_string()))
}

async fn dm_conversation_id_for_run(
    pool: &DbPool,
    run: &RuntimeRun,
) -> Result<Option<String>, sqlx::Error> {
    let Some(conversation_id) = run.conversation_id.as_deref() else {
        return Ok(None);
    };

    let kind = sqlx::query_scalar::<_, String>("SELECT kind FROM conversations WHERE id = $1")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?;

    Ok(kind
        .filter(|kind| kind == "dm")
        .map(|_| conversation_id.to_string()))
}

async fn running_count(pool: &DbPool) -> Result<usize, sqlx::Error> {
    let count =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM agent_runs WHERE status = 'running'")
            .fetch_one(pool)
            .await?;
    Ok(count.max(0) as usize)
}

async fn running_count_for_agent(pool: &DbPool, agent_id: &str) -> Result<usize, sqlx::Error> {
    let count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_runs WHERE agent_id = $1 AND status = 'running'",
    )
    .bind(agent_id)
    .fetch_one(pool)
    .await?;
    Ok(count.max(0) as usize)
}

async fn read_usize_setting(
    pool: &DbPool,
    key: &str,
    fallback: usize,
) -> Result<usize, sqlx::Error> {
    if let Some(value) = read_setting_value(pool, key).await? {
        let Ok(parsed) = value.trim().parse::<usize>() else {
            return Ok(fallback);
        };
        return Ok(parsed.clamp(1, MAX_ACTIVE_RUNS_SETTING));
    }

    Ok(fallback)
}

async fn read_setting_value(pool: &DbPool, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
}

async fn read_string_setting(pool: &DbPool, key: &str) -> Result<Option<String>, sqlx::Error> {
    let value = read_setting_value(pool, key).await?;
    Ok(value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty()))
}

fn parse_json(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| {
        json!({
            "raw": raw
        })
    })
}

fn exit_error_text(code: Option<i32>, stderr_tail: &str) -> String {
    let status = match code {
        Some(code) => format!("Codex exited with status {code}."),
        None => "Codex exited without a status code.".to_string(),
    };
    if stderr_tail.trim().is_empty() {
        status
    } else {
        format!("{status} Last stderr line: {}", stderr_tail.trim())
    }
}

#[cfg(test)]
pub async fn run_one_queued_for_test(
    pool: DbPool,
    supervisor: RunSupervisor,
) -> Result<(), sqlx::Error> {
    if let Some(candidate) = queue_candidates(&pool, DEFAULT_PER_AGENT_ACTIVE_RUNS)
        .await?
        .into_iter()
        .next()
    {
        if let Some(run) = claim_run(&pool, &candidate.id).await? {
            supervisor.mark_active(&run.agent_id, &run.id);
            execute_run(pool, supervisor, run).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        RunSupervisor, RuntimeRun, command_plan_for_run, extract_codex_session_id,
        extract_final_message, is_codex_tool_sandbox_failure, is_ignorable_codex_stderr,
        queue_candidates, run_one_queued_for_test, scrub_codex_controller_env,
        set_agent_thread_active_in_tx, write_agent_codex_session_id,
    };
    use crate::db::DbPool;
    use crate::db::init_database;
    use serde_json::json;
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use tempfile::TempDir;
    use uuid::Uuid;

    #[test]
    fn extracts_codex_task_complete_final_message() {
        let value = json!({
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "last_agent_message": "done"
            }
        });
        assert_eq!(extract_final_message(&value), Some("done"));
    }

    #[test]
    fn extracts_codex_final_answer_message() {
        let value = json!({
            "type": "event_msg",
            "payload": {
                "type": "agent_message",
                "phase": "final_answer",
                "message": "final dm"
            }
        });
        assert_eq!(extract_final_message(&value), Some("final dm"));
    }

    #[test]
    fn extracts_current_codex_item_completed_message() {
        let value = json!({
            "type": "item.completed",
            "item": {
                "id": "item_0",
                "type": "agent_message",
                "text": "current final"
            }
        });
        assert_eq!(extract_final_message(&value), Some("current final"));
    }

    #[test]
    fn extracts_current_codex_thread_id() {
        let value = json!({
            "type": "thread.started",
            "thread_id": "019dcd0f-5121-76c1-98b3-6526c38dd711"
        });
        assert_eq!(
            extract_codex_session_id(&value),
            Some("019dcd0f-5121-76c1-98b3-6526c38dd711")
        );
    }

    #[test]
    fn scrub_codex_controller_env_removes_parent_thread_metadata() {
        let mut command = Command::new("codex");
        scrub_codex_controller_env(&mut command);

        let env_updates: Vec<_> = command.get_envs().collect();
        assert!(env_updates.contains(&(OsStr::new("CODEX_THREAD_ID"), None)));
        assert!(env_updates.contains(&(OsStr::new("CODEX_CI"), None)));
    }

    #[test]
    fn rollout_recording_warning_is_ignorable_codex_stderr() {
        assert!(is_ignorable_codex_stderr(
            "2026-04-27T06:59:52.158811Z ERROR codex_core::session: failed to record rollout items: thread 019dcd1b-2711-7161-ad05-de6553c2107e not found"
        ));
        assert!(!is_ignorable_codex_stderr(
            "2026-04-27T06:59:52.158811Z ERROR codex_core::session: failed to launch tool"
        ));
    }

    #[test]
    fn codex_tool_sandbox_failure_is_detected_from_agent_message() {
        assert!(is_codex_tool_sandbox_failure(
            "Blocked before shell startup: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted"
        ));
        assert!(!is_codex_tool_sandbox_failure("ordinary command failed"));
    }

    #[test]
    fn supervisor_tracks_multiple_active_runs_for_same_agent() {
        let supervisor = RunSupervisor::new();

        supervisor.mark_active("agent_runtime", "run_one");
        supervisor.mark_active("agent_runtime", "run_two");

        assert!(supervisor.is_run_active("run_one"));
        assert!(supervisor.is_run_active("run_two"));

        supervisor.clear_active("agent_runtime", "run_one");
        assert!(!supervisor.is_run_active("run_one"));
        assert!(supervisor.is_run_active("run_two"));

        supervisor.clear_active("other_agent", "run_two");
        assert!(supervisor.is_run_active("run_two"));

        supervisor.clear_active("agent_runtime", "run_two");
        assert!(!supervisor.is_run_active("run_two"));
    }

    #[test]
    fn supervisor_reserves_capacity_before_claiming_run() {
        let supervisor = RunSupervisor::new();

        assert!(supervisor.try_mark_active("agent_one", "run_one", 2, 1));
        assert!(!supervisor.try_mark_active("agent_one", "run_two", 2, 1));
        assert!(supervisor.try_mark_active("agent_two", "run_three", 2, 1));
        assert!(!supervisor.try_mark_active("agent_three", "run_four", 2, 1));

        supervisor.clear_active("agent_one", "run_one");
        assert!(supervisor.try_mark_active("agent_three", "run_four", 2, 1));
    }

    #[tokio::test]
    async fn queue_candidates_skip_agents_already_at_capacity() {
        let _temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");

        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES
              ('agent_busy', 'Busy Agent', 'busy-agent', 'tester', '', '', ''),
              ('agent_free', 'Free Agent', 'free-agent', 'tester', '', '', '')
            "#,
        )
        .execute(&pool)
        .await
        .expect("seed agents");
        sqlx::query(
            "INSERT INTO agent_runs (id, agent_id, status, prompt) VALUES ('busy_running', 'agent_busy', 'running', 'active')",
        )
        .execute(&pool)
        .await
        .expect("seed active busy run");

        for index in 0..40 {
            sqlx::query(
                "INSERT INTO agent_runs (id, agent_id, status, prompt, queue_priority) VALUES ($1, 'agent_busy', 'queued', 'busy queued', 0)",
            )
            .bind(format!("busy_queued_{index:02}"))
            .execute(&pool)
            .await
            .expect("seed blocked queued run");
        }
        sqlx::query(
            "INSERT INTO agent_runs (id, agent_id, status, prompt, queue_priority) VALUES ('free_queued', 'agent_free', 'queued', 'free queued', 100)",
        )
        .execute(&pool)
        .await
        .expect("seed free queued run");

        let candidates = queue_candidates(&pool, 1).await.expect("candidates");

        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.id == "free_queued")
        );
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.agent_id != "agent_busy")
        );
    }

    #[tokio::test]
    async fn fake_codex_final_output_is_written_to_dm() {
        let temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");
        let fake_codex = temp.path().join("fake-codex.sh");
        fs::write(
            &fake_codex,
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '2026-04-27T06:59:52.158811Z ERROR codex_core::session: failed to record rollout items: thread 019dcd0f-5121-76c1-98b3-6526c38dd711 not found' >&2\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"019dcd0f-5121-76c1-98b3-6526c38dd711\"}'\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"fake final\"}}'\nprintf '%s\\n' '{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"last_agent_message\":\"fake final\"}}'\n",
        )
        .expect("fake codex script");
        let mut permissions = fs::metadata(&fake_codex).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_codex, permissions).expect("permissions");

        seed_runtime_test_run(&pool, fake_codex.to_string_lossy().as_ref())
            .await
            .expect("seed");

        run_one_queued_for_test(pool.clone(), RunSupervisor::new())
            .await
            .expect("run");

        let status =
            sqlx::query_scalar::<_, String>("SELECT status FROM agent_runs WHERE id = 'run_fake'")
                .fetch_one(&pool)
                .await
                .expect("status");
        assert_eq!(status, "completed");

        let body = sqlx::query_scalar::<_, String>(
            "SELECT body FROM messages WHERE run_id = 'run_fake' AND author_kind = 'agent'",
        )
        .fetch_one(&pool)
        .await
        .expect("message");
        assert_eq!(body, "fake final");

        let event_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM run_events WHERE run_id = 'run_fake' AND event_type = 'codex.stdout'",
        )
        .fetch_one(&pool)
        .await
        .expect("events");
        assert_eq!(event_count, 3);

        let stderr_event_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM run_events WHERE run_id = 'run_fake' AND event_type = 'codex.stderr'",
        )
        .fetch_one(&pool)
        .await
        .expect("stderr events");
        assert_eq!(stderr_event_count, 0);

        let session_id = sqlx::query_scalar::<_, String>(
            "SELECT codex_session_id FROM agent_threads WHERE agent_id = 'agent_fake'",
        )
        .fetch_one(&pool)
        .await
        .expect("session");
        assert_eq!(session_id, "019dcd0f-5121-76c1-98b3-6526c38dd711");

        let active_run_id = sqlx::query_scalar::<_, Option<String>>(
            "SELECT active_run_id FROM agent_threads WHERE agent_id = 'agent_fake'",
        )
        .fetch_one(&pool)
        .await
        .expect("active run");
        assert_eq!(active_run_id, None);

        let resume_run = RuntimeRun {
            id: "run_resume".to_string(),
            agent_id: "agent_fake".to_string(),
            conversation_id: Some("dm_agent_fake".to_string()),
            prompt: "Continue".to_string(),
            model: "gpt-5.5".to_string(),
            reasoning_effort: "high".to_string(),
            workspace: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            command_json: json!({
                "program": fake_codex.to_string_lossy()
            })
            .to_string(),
        };
        let command = command_plan_for_run(&pool, &resume_run)
            .await
            .expect("resume command");
        assert_eq!(command.program, fake_codex.to_string_lossy());
        assert_eq!(command.args.first().map(String::as_str), Some("exec"));
        assert_eq!(command.args.get(1).map(String::as_str), Some("resume"));
        assert!(
            command
                .args
                .contains(&"019dcd0f-5121-76c1-98b3-6526c38dd711".to_string())
        );
        assert!(!command.args.contains(&"--cd".to_string()));
        assert!(!command.args.contains(&"--sandbox".to_string()));
        assert!(
            command
                .args
                .contains(&"--dangerously-bypass-approvals-and-sandbox".to_string())
        );
        assert!(
            command
                .args
                .contains(&"sandbox_mode=\"danger-full-access\"".to_string())
        );
    }

    #[tokio::test]
    async fn sandbox_blocker_final_message_fails_run_and_clears_session() {
        let temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");
        let fake_codex = temp.path().join("fake-codex-sandbox-blocked.sh");
        fs::write(
            &fake_codex,
            "#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"019dcd0f-5121-76c1-98b3-6526c38dd711\"}'\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"Blocked: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\"}}'\n",
        )
        .expect("fake codex script");
        let mut permissions = fs::metadata(&fake_codex).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_codex, permissions).expect("permissions");

        seed_runtime_test_run(&pool, fake_codex.to_string_lossy().as_ref())
            .await
            .expect("seed");

        run_one_queued_for_test(pool.clone(), RunSupervisor::new())
            .await
            .expect("run");

        let status =
            sqlx::query_scalar::<_, String>("SELECT status FROM agent_runs WHERE id = 'run_fake'")
                .fetch_one(&pool)
                .await
                .expect("status");
        assert_eq!(status, "failed");

        let session_id = sqlx::query_scalar::<_, String>(
            "SELECT codex_session_id FROM agent_threads WHERE agent_id = 'agent_fake'",
        )
        .fetch_one(&pool)
        .await
        .expect("session");
        assert_eq!(session_id, "");

        let cleared_count = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM run_events WHERE run_id = 'run_fake' AND event_type = 'codex.session_cleared'",
        )
        .fetch_one(&pool)
        .await
        .expect("cleared event");
        assert_eq!(cleared_count, 1);
    }

    #[tokio::test]
    async fn final_action_block_posts_messages_wiki_and_queues_agent_dm() {
        let temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");
        let final_message = format!(
            "Done.\n\n```agent_adda.actions\n{}\n```",
            json!({
                "actions": [
                    {
                        "type": "dm",
                        "to_agent": "Target Agent",
                        "body": "Please respond."
                    },
                    {
                        "type": "channel_post",
                        "to_channel": "engineering",
                        "body": "Posted an engineering update."
                    },
                    {
                        "type": "wiki_upsert",
                        "title": "Communication Note",
                        "body_markdown": "# Communication Note\n\nA durable note from an agent action.",
                        "change_summary": "Captured communication note"
                    }
                ]
            })
        );
        let event_line = json!({
            "type": "item.completed",
            "item": {
                "id": "item_0",
                "type": "agent_message",
                "text": final_message
            }
        })
        .to_string();
        let fake_codex = temp.path().join("fake-codex-actions.sh");
        fs::write(
            &fake_codex,
            format!("#!/bin/sh\ncat >/dev/null\ncat <<'JSON'\n{event_line}\nJSON\n"),
        )
        .expect("fake codex script");
        let mut permissions = fs::metadata(&fake_codex).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_codex, permissions).expect("permissions");

        seed_runtime_test_run(&pool, fake_codex.to_string_lossy().as_ref())
            .await
            .expect("seed source");
        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES ('agent_target', 'Target Agent', 'target-agent', 'reviewer', '', '', 'Review work.')
            "#,
        )
        .execute(&pool)
        .await
        .expect("target agent");
        sqlx::query(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES ('workspace_path', $1, CURRENT_TIMESTAMP::text)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP::text
            "#,
        )
        .bind(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
        )
        .execute(&pool)
        .await
        .expect("workspace setting");

        run_one_queued_for_test(pool.clone(), RunSupervisor::new())
            .await
            .expect("run");

        let visible_dm = sqlx::query_scalar::<_, String>(
            "SELECT body FROM messages WHERE conversation_id = 'dm_agent_fake' AND run_id = 'run_fake' AND author_kind = 'agent'",
        )
        .fetch_one(&pool)
        .await
        .expect("visible dm");
        assert_eq!(visible_dm, "Done.");

        let channel_post = sqlx::query_scalar::<_, String>(
            "SELECT body FROM messages WHERE conversation_id = 'channel_engineering' AND run_id = 'run_fake' AND author_id = 'agent_fake'",
        )
        .fetch_one(&pool)
        .await
        .expect("channel post");
        assert_eq!(channel_post, "Posted an engineering update.");

        let wiki_body = sqlx::query_scalar::<_, String>(
            "SELECT body_markdown FROM wiki_pages WHERE slug = 'communication-note' AND archived_at IS NULL",
        )
        .fetch_one(&pool)
        .await
        .expect("wiki body");
        assert!(wiki_body.contains("A durable note from an agent action."));

        let queued = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT id, trigger_kind, queued_by, prompt_summary FROM agent_runs WHERE agent_id = 'agent_target'",
        )
        .fetch_one(&pool)
        .await
        .expect("queued target run");
        assert_eq!(queued.1, "agent-dm");
        assert_eq!(queued.2, "agent_fake");
        assert_eq!(queued.3, "Please respond.");

        let target_dm = sqlx::query_as::<_, (String, String)>(
            "SELECT body, run_id FROM messages WHERE conversation_id = 'dm_agent_target' AND author_id = 'agent_fake'",
        )
        .fetch_one(&pool)
        .await
        .expect("target dm");
        assert_eq!(target_dm.0, "Please respond.");
        assert_eq!(target_dm.1, queued.0);

        let report = sqlx::query_scalar::<_, String>(
            "SELECT payload_json FROM run_events WHERE run_id = 'run_fake' AND event_type = 'agent.communication_applied'",
        )
        .fetch_one(&pool)
        .await
        .expect("communication report");
        let report: serde_json::Value = serde_json::from_str(&report).expect("report json");
        assert_eq!(report["dm_posts"].as_u64(), Some(1));
        assert_eq!(report["channel_posts"].as_u64(), Some(1));
        assert_eq!(report["wiki_upserts"].as_u64(), Some(1));
        assert_eq!(report["queued_runs"].as_u64(), Some(1));
    }

    #[tokio::test]
    async fn channel_run_does_not_replace_agent_dm_thread() {
        let _temp = TempDir::new().expect("tempdir");
        let database_url = std::env::var("AGENT_ADDA_TEST_DATABASE_URL").unwrap_or_else(|_| {
            "postgres://agent_adda:agent_adda@127.0.0.1:15432/agent_adda_test".to_string()
        });
        let pool = init_database(&database_url).await.expect("database");

        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES ('agent_channel', 'Channel Agent', 'channel-agent', 'tester', '', '', '')
            "#,
        )
        .execute(&pool)
        .await
        .expect("agent");
        sqlx::query(
            r#"
            INSERT INTO conversations (id, kind, name, slug, topic)
            VALUES
              ('dm_agent_channel', 'dm', 'Channel Agent', 'channel-agent', 'Direct message'),
              ('channel_agent_test', 'channel', 'agent-test', 'agent-test', 'Agent test')
            "#,
        )
        .execute(&pool)
        .await
        .expect("conversations");
        sqlx::query(
            "INSERT INTO agent_threads (agent_id, conversation_id) VALUES ('agent_channel', 'dm_agent_channel')",
        )
        .execute(&pool)
        .await
        .expect("thread");
        sqlx::query(
            r#"
            INSERT INTO agent_runs (
                id,
                agent_id,
                conversation_id,
                status,
                trigger_kind,
                prompt,
                model,
                reasoning_effort,
                workspace,
                command_json
            )
            VALUES (
                'run_channel',
                'agent_channel',
                'channel_agent_test',
                'running',
                'manual',
                'Work from channel',
                'gpt-5.5',
                'high',
                $1,
                '{"program":"codex"}'
            )
            "#,
        )
        .bind(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
        )
        .execute(&pool)
        .await
        .expect("run");

        let run = RuntimeRun {
            id: "run_channel".to_string(),
            agent_id: "agent_channel".to_string(),
            conversation_id: Some("channel_agent_test".to_string()),
            prompt: "Work from channel".to_string(),
            model: "gpt-5.5".to_string(),
            reasoning_effort: "high".to_string(),
            workspace: std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
            command_json: json!({
                "program": "codex"
            })
            .to_string(),
        };

        let mut tx = pool.begin().await.expect("tx");
        set_agent_thread_active_in_tx(&mut tx, &run)
            .await
            .expect("active thread");
        tx.commit().await.expect("commit");
        write_agent_codex_session_id(&pool, &run, "019dcd0f-5121-76c1-98b3-6526c38dd711")
            .await
            .expect("session");

        let row = sqlx::query_as::<_, (String, Option<String>, String)>(
            "SELECT conversation_id, active_run_id, codex_session_id FROM agent_threads WHERE agent_id = 'agent_channel'",
        )
        .fetch_one(&pool)
        .await
        .expect("thread row");
        assert_eq!(row.0, "dm_agent_channel");
        assert_eq!(row.1.as_deref(), Some("run_channel"));
        assert_eq!(row.2, "019dcd0f-5121-76c1-98b3-6526c38dd711");
    }

    async fn seed_runtime_test_run(pool: &DbPool, fake_codex: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO agents (id, name, slug, role, description, profile, system_prompt)
            VALUES ('agent_fake', 'Fake Agent', 'fake-agent', 'tester', '', '', '')
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            r#"
            INSERT INTO conversations (id, kind, name, slug, topic)
            VALUES ('dm_agent_fake', 'dm', 'Fake Agent', 'fake-agent', 'Direct message with Fake Agent')
            "#,
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ('dm_agent_fake', 'human', 'owner')",
        )
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, member_kind, member_id) VALUES ('dm_agent_fake', 'agent', 'agent_fake')",
        )
        .execute(pool)
        .await?;

        let command_json = json!({
            "program": fake_codex,
            "args": []
        })
        .to_string();
        sqlx::query(
            r#"
            INSERT INTO agent_runs (
                id,
                agent_id,
                conversation_id,
                status,
                trigger_kind,
                prompt,
                prompt_hash,
                prompt_summary,
                summary,
                model,
                reasoning_effort,
                branch,
                workspace,
                command_json,
                created_at,
                updated_at
            )
            VALUES (
                'run_fake',
                'agent_fake',
                'dm_agent_fake',
                'queued',
                'tab',
                'Say hello',
                $1,
                'Say hello',
                '',
                'fake-model',
                'high',
                '',
                $2,
                $3,
                CURRENT_TIMESTAMP::text,
                CURRENT_TIMESTAMP::text
            )
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(
            std::env::current_dir()
                .unwrap()
                .to_string_lossy()
                .to_string(),
        )
        .bind(command_json)
        .execute(pool)
        .await?;

        Ok(())
    }
}
