# Herdr AI Usage

A zero-dependency [Herdr](https://herdr.dev) plugin that displays live quota and rate-limit windows for Claude Code, Codex, and OpenCode in one popup.

The plugin reads provider-native or local usage data, renders compact progress bars, keeps the last successful rate-limit response as a fallback when a provider is temporarily unavailable, and records a small local history so the panel can show a short trend.

## Features

- Claude Code OAuth quota: 5-hour, weekly, and Fable windows when available.
- Codex quota through the local `codex app-server` JSON-RPC interface.
- OpenCode quota through an authenticated opencode.ai session cookie.
- Local “today” token totals from Claude and Codex session logs, plus OpenCode's local SQLite database when available.
- Compact usage history and trend sparkline.
- Cached last-good provider windows instead of replacing the whole panel with an error.
- Offline self-test for the parser and formatting helpers.
- No npm dependencies, build step, or API key stored by the plugin.

## Requirements

- Herdr `0.7.0` or newer.
- Node.js `18` or newer. Node 22 is recommended because it includes `node:sqlite` for the optional OpenCode daily total.
- Claude Code and/or Codex installed and logged in for those providers.
- OpenCode setup is optional.

The plugin supports macOS, Linux, and Windows in its manifest. Provider credential locations are platform-dependent; the Claude Keychain lookup is macOS-specific.

## Install from GitHub

After Herdr is installed, run:

```bash
herdr plugin install itisbryan/herdr-usage
```

Open the popup with:

```bash
herdr plugin pane open --plugin herdr-usage --entrypoint panel
```

The plugin also contributes a workspace action named **Show AI usage**. Use that action from Herdr's workspace menu, or invoke the action directly:

```bash
herdr plugin action invoke herdr-usage.show --plugin herdr-usage
```

## Install a local checkout

For development or a local version:

```bash
git clone https://github.com/itisbryan/herdr-usage.git
herdr plugin link ./herdr-usage
```

To confirm that Herdr sees the plugin:

```bash
herdr plugin list --plugin herdr-usage
```

Because the plugin is linked, edits to `usage.mjs` are picked up the next time the pane is opened.

## Configure OpenCode

Claude and Codex need no plugin configuration beyond being logged in. OpenCode does not expose the same local credential interface, so the plugin accepts an authenticated browser cookie.

1. Print the plugin's config directory:

   ```bash
   herdr plugin config-dir herdr-usage
   ```

2. Create a file named `.env` in that directory.

3. Add the `auth` cookie value or a complete Cookie header:

   ```dotenv
   OPENCODE_COOKIE=Fe26.2**...
   ```

   A complete header also works:

   ```dotenv
   OPENCODE_COOKIE=auth=Fe26.2**...; other_cookie=value
   ```

4. Reopen the panel.

If workspace discovery does not find the expected workspace, optionally pin one:

```dotenv
OPENCODE_WORKSPACE_ID=wrk_xxxxxxxxx
```

### Getting the OpenCode cookie

In a browser where `opencode.ai` is already signed in, open Developer Tools, inspect a request to `opencode.ai`, and copy the `auth` cookie value. Treat this value like a password:

- Do not commit it.
- Do not paste it into an issue or chat.
- Remove or rotate it if it is accidentally exposed.

The plugin sends only the filtered `auth`/`__Host-auth` cookie names to opencode.ai.

## How provider loading works

### Claude Code

The plugin requests:

```text
GET https://api.anthropic.com/api/oauth/usage
```

On macOS it first reads the `Claude Code-credentials` generic password from Keychain. It falls back to `~/.claude/.credentials.json` on all platforms. A missing or expired credential is reported as a provider-specific error.

### Codex

The plugin starts the installed Codex CLI in read-only mode:

```text
codex -s read-only -a never app-server
```

It then performs the app-server JSON-RPC handshake and calls:

```text
account/rateLimits/read
```

The primary and secondary windows are mapped to labels such as `5h` and `Week`. Codex must be available on `PATH` and authenticated with:

```bash
codex login
```

You can verify the underlying command independently:

```bash
codex --version
codex doctor
```

### OpenCode

The plugin uses the configured cookie to:

1. Discover workspaces from `/_server`.
2. Request each workspace's `/workspace/<id>/go` page.
3. Parse the subscription usage windows from the returned page.

This path intentionally has no dependency on private OpenCode client code, but it is more fragile than the Claude and Codex integrations because it parses page data.

## Panel behavior

The panel refreshes on open and every 30 seconds. While it is open, pressing any key triggers an immediate refresh; `q`, Escape, and Ctrl-C close it.

For each provider, the panel may show:

- Current usage percentage and a progress bar.
- The next reset time.
- A `cached ... ago` marker when the provider request failed but a previous successful response is available.
- Today's local input/output token totals where the relevant local logs are present.
- A short trend sparkline after enough samples have been collected.

The cache and history are local runtime state. They are not required for provider loading and are intentionally ignored by Git.

## Keybinding example

Herdr keybindings belong in the user's Herdr configuration, not in this plugin manifest. For example:

```toml
[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "herdr-usage.show"
description = "AI usage panel"
```

Reload Herdr's configuration after changing it:

```bash
herdr server reload-config
```

## Development

There is no build step. Run the script directly:

```bash
node usage.mjs
```

Run the offline self-test:

```bash
node usage.mjs --selftest
```

The self-test covers progress-bar formatting, reset formatting, OpenCode usage parsing, cookie normalization, Codex window labels, token formatting, scaling, and trend rendering. It does not make network requests or require provider credentials.

For a quick integration check, run the panel in a non-interactive terminal and confirm that the Codex section reports fresh windows rather than a cached timestamp:

```bash
node usage.mjs
```

## Repository layout

```text
herdr-plugin.toml  Herdr plugin manifest, pane, and action definitions
usage.mjs         Provider fetchers, local usage readers, renderer, and self-test
README.md         This documentation
.gitignore        Runtime-state exclusions
```

## Security and privacy

- Credentials are read from existing local login stores or the plugin's local `.env` file.
- The repository contains no credentials and does not require a new API key.
- Provider responses are not uploaded to a Herdr service by this plugin.
- Usage history and last-good responses stay on the local machine.
- OpenCode cookies grant access to an authenticated session; protect them accordingly.

## Limitations

- OpenCode page scraping can break when opencode.ai changes its HTML or React Flight payload.
- The local “today” totals are estimates based on provider log formats and are not billing statements.
- A session spanning midnight can cause Codex's daily total to be slightly over-counted because Codex records cumulative session totals.
- A provider can be unavailable while its cached windows continue to display; the `cached ... ago` label identifies that condition.
- The plugin does not expose per-request or per-file usage detail.

## License

No license has been selected yet. Until a license is added, the repository is public for viewing and evaluation, but normal copyright restrictions still apply.

## Acknowledgements

The provider-fetching approach is informed by [stablyai/orca](https://github.com/stablyai/orca), especially its rate-limit integrations.
