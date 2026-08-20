# opencode-cmux

[![npm](https://img.shields.io/npm/v/opencode-cmux)](https://www.npmjs.com/package/opencode-cmux)

OpenCode plugin that bridges OpenCode events to cmux notifications and sidebar metadata.

## Requirements

- OpenCode ≥ 1.0
- [cmux](https://cmux.app) (macOS app) installed; the plugin invokes `cmux` via `$CMUX_BUNDLED_CLI_PATH` (set by cmux's shell integration), falling back to `cmux` on `$PATH`
- The plugin is a no-op when not running inside a cmux workspace

## Installation

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-cmux"]
}
```

OpenCode will download the package automatically on next start.

### Local / development

Build the package, then symlink the output directly into OpenCode's plugin directory:

```bash
ln -sf ~/path/to/opencode-cmux/dist/index.js ~/.config/opencode/plugins/cmux.js
```

Make sure `opencode-cmux` is **not** listed in `opencode.json` when using the symlink, to avoid loading it twice.

## Configuration

Create `~/.config/opencode/opencode-cmux.json` to customize plugin behavior:

```json
{
  "splits": true,
  "notifications": {
    "done": false
  }
}
```

| Option                     | Type    | Default | Description                                              |
|----------------------------|---------|---------|----------------------------------------------------------|
| `splits`                   | boolean | `false` | Open cmux split panes for subagent sessions              |
| `notifications.done`       | boolean | `true`  | Show a popup when a session finishes                     |
| `notifications.permission` | boolean | `true`  | Show a popup when OpenCode requests a permission         |
| `notifications.question`   | boolean | `true`  | Show a popup when OpenCode asks a clarifying question    |
| `notifications.error`      | boolean | `true`  | Show a popup when a session errors                       |

If the file does not exist or any key is omitted, defaults are used. Each notification type can be toggled independently — useful when running multiple agents in parallel and per-turn `Done` popups become noisy.

## Subagent splits

When `splits` is enabled and a subagent spawns, the plugin opens a cmux split with a live `opencode attach` view. Requires `--port` to expose an HTTP server:

```bash
opencode --port 0  # binds to first available port
```

Without `--port`, splits are silently skipped even when enabled.

## What it does

| Event | cmux action |
|---|---|
| Any session is busy/retrying, or a `task` tool is running | Sidebar status: "Running" (blue, bolt icon) |
| Permission or question is pending | Sidebar status: "Needs input" (blue, bell icon) |
| No activity or input remains | Sidebar status: "Idle" (gray, pause icon) after 250 ms |
| Session completes (primary) | Desktop notification + log |
| Session completes (subagent) | Log only (no notification spam) |
| Session error | Desktop notification + log |
| Permission requested | Desktop notification + log |
| AI has a question (`ask` tool) | Desktop notification + log |

The sidebar key is `opencode-subagents:$CMUX_SURFACE_ID` (trimmed), falling
back to `opencode-subagents:pid:$PID` when no surface ID is available.

## How it works

The plugin responds to OpenCode lifecycle events by firing cmux CLI commands (`cmux rpc notification.create`, `cmux set-status`, etc.). Each action targets the current cmux workspace, providing ambient awareness of what OpenCode is doing without requiring you to switch context. All commands are no-ops when cmux is not running.

## License

MIT
