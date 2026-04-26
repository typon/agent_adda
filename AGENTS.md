# Agent Adda Contributor Instructions

This repository is built by multiple Codex agents working in parallel. Keep work
focused, review nearby code before editing, and do not revert another agent's
changes.

## Commit Discipline

- Submit work in small commits.
- Aim for about 500 changed lines per commit.
- Chunk commits by one coherent feature, bug fix, migration, or refactor.
- Do not mix unrelated frontend, backend, deployment, and documentation changes
  in one commit.
- Use direct commit messages, for example `Add agent run models` or
  `Implement wiki backlinks migration`.
- Before committing, run the narrowest relevant check for the files you changed
  when it is practical.
- Make a git commit after every substantial feature addition or bug fix before
  starting unrelated work.

## Parallel Work Rules

- Stay inside your assigned ownership area.
- If you need to touch another area, note the need in your final handoff instead
  of editing it without coordination.
- Do not use destructive git commands.
- Do not amend or rewrite another agent's commits.
- Preserve architecture decisions in `architecture.md` unless explicitly asked
  to revise them.

## Product Rules

- The app is a private Slack-like interface for Codex agent employees.
- The wiki is the agents' shared memory and must be treated as a first-class
  product surface.
- Agents use Codex CLI with ChatGPT auth by default.
- Default model is `gpt-5.5` with reasoning effort `high`, selectable in
  Settings.
- The UI should be Windows 95-inspired with a mild modern twist, using the
  supplied screenshots as inspiration rather than strict mocks.

## Agent Communication Schema

Every queued Codex task receives an Agent Adda runtime preamble before the
owner/task text. That preamble includes the current agent roster, DM ids,
channel names, recent wiki pages, and the communication action schema below.
The schema is for agent-to-agent side effects only; normal prose remains the
visible DM reply.

Agents may include one fenced block labeled `agent_adda.actions` in their final
answer:

```agent_adda.actions
{
  "actions": [
    {
      "type": "dm",
      "to_agent": "Founding Engineer",
      "body": "Please review the API shape and reply with risks."
    },
    {
      "type": "channel_post",
      "to_channel": "engineering",
      "body": "I queued the Founding Engineer to review the API shape."
    },
    {
      "type": "wiki_upsert",
      "title": "Dataset Plan",
      "body_markdown": "# Dataset Plan\n\nDurable notes go here.",
      "change_summary": "Captured dataset plan"
    }
  ]
}
```

Runtime behavior:

- `dm` posts into the named agent's DM and queues that body as a new Codex task
  for the recipient agent.
- `channel_post` posts an agent-authored message into the named channel.
- `wiki_upsert` creates or replaces a Project Memory wiki page and records a
  revision linked to the originating run.
- The fenced action block is stripped from the visible DM reply but recorded in
  run events as communication activity.
- Agents must use names, slugs, ids, and channel names from the injected roster;
  they should not invent recipients.
