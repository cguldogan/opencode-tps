# OpenCode agent stats

An OpenCode TUI plugin that keeps LLM performance visible in both the main session and subagent sessions.

## Features

- Footer in every session: live estimated TPS, measured average generation rate, TTFT, and output tokens.
- `TREE` line aggregating the selected session and all descendant agents.
- Background history loading, so agents are measured even when their view is not open.
- `/llmstats` dialog with each session's agent, model, status, token counts, and timing.
- Tool execution time excluded from generation averages.
- Safe handling of duplicate events, retries, errors, stale streams, and parallel agents.

`TPS` is prefixed with `~` while streaming because OpenCode exposes text deltas, not exact live token counts. Completed `AVG` uses provider-reported output plus reasoning tokens over persisted text/reasoning spans.

## Screenshots

### Session footer

Stats for the current session and live activity across its agent tree.

![Session footer with main-agent TPS, average generation rate, TTFT, and combined tree activity](assets/session-footer.png)

### Agent details

Use `/llmstats` to inspect agents and select a session to open.

![LLM stats dialog listing the main session and developer subagent with models and token counts](assets/agent-details.png)

## Install from this Git repository

The OpenCode plugin installer accepts npm modules. For this Git repository, clone it and reference the TUI entrypoint in `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-tps/tui.tsx"
  ]
}
```

For example:

```bash
git clone git@github.com:cguldogan/opencode-tps.git ~/.config/opencode/tui-plugins/opencode-tps
```

Then set the file URL to `~/.config/opencode/tui-plugins/opencode-tps/tui.tsx` and restart OpenCode. Type `/llmstats` in a session to open the detailed view.

## Development

```bash
npm install
npm test
npm run typecheck
```
