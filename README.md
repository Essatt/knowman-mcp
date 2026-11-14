# KnowMan MCP Server

Connect any MCP-capable AI agent — Claude Desktop, Claude Code, Cursor — to your KnowMan Knowledge Base.

A standalone stdio MCP server that talks to KnowMan's public HTTP API with a Bearer API key. It never touches the database directly, and it writes protocol messages only through the MCP transport (diagnostics go to stderr, so they cannot corrupt the stdio stream).

## Tools

| Tool | What it does | Required scopes |
| --- | --- | --- |
| `kb_research` | Retrieves ranked evidence across the whole library and memories; the client model writes the answer. | `research` + `items:read` |
| `kb_get_item` | Fetch readable content and metadata for one item. | `items:read` |
| `kb_recent` | List recently saved Inbox or Knowledge Base items. | `items:read` |
| `kb_save` | Save a URL to the Inbox or the Knowledge Base, optionally with a note. | `items:write` |

`kb_search`, `kb_ask` and `kb_memories` are deprecated in favour of `kb_research`. They still work on the stdio package (0.3.2) and will be removed from it in a later release. `kb_ask` searches the whole library (Inbox and Knowledge Base) by default; its optional `scope` input narrows it to `kb` (Knowledge Base only) or `inbox` (Inbox only). With `itemId` the question is limited to that one item and `scope` is ignored. They have already left the hosted remote server, which exposes only `kb_research`, `kb_get_item`, `kb_recent` and `kb_save`.

## Install

### With `npx` (recommended)

```bash
npx -y @knowman/mcp
```

Node 22 or newer. Nothing else to install — the published bundle inlines its dependencies, so `npx` downloads one package and no transitive tree.

### From this repository

```bash
npm install
bun run build       # produces dist/index.js
node dist/index.js  # or: bun src/index.ts
```

Use the absolute path to `dist/index.js` in the client configs below wherever they say `npx -y @knowman/mcp`.

## CLI

`knowman` is a second driver over the same tool registry the MCP server uses (`src/tools.ts`): every command, flag and validation rule is generated from `TOOL_DEFINITIONS` at runtime, and each command calls the exact same handler the MCP server calls for that tool. Adding a tool to the registry adds it to both surfaces — there is no separate CLI implementation to keep in sync.

```bash
npx -p @knowman/mcp knowman kb-search --query "some text" --limit 5
```

Underscore tool names work too (`kb_search` as well as `kb-search`). From this repository:

```bash
bun run build   # produces dist/cli.js
node dist/cli.js kb-search --query "some text"
# or, without building: bun src/cli.ts kb-search --query "some text"
```

Short names work for every command: `knowman search --query "pricing" --format json`, `knowman save --url https://example.com`, `ask`, `recent`, `memories`, `get-item`.

### Sign in once: CLI and MCP share one credential

```bash
npx -p @knowman/mcp knowman login     # opens your browser, press Authorize
npx -p @knowman/mcp knowman status    # signed in? (never prints the key)
npx -p @knowman/mcp knowman logout    # revokes the saved key on the server and removes it
```

`knowman login` starts a one-shot listener on `127.0.0.1`, opens `app.knowman.io/cli-auth`, and waits. After you press **Authorize** the page mints a least-privilege `cli` key (the five scopes in the table above, 90-day expiry) and posts it to that local listener, bound to this terminal session by a random `state` (this is not PKCE: the key itself travels browser to loopback, guarded by that state, Host and Origin checks and your explicit Authorize click). The key is written to `auth.json` in your user config directory (`~/.config/knowman/`, `$XDG_CONFIG_HOME/knowman/`, `%APPDATA%\knowman\`, or `$KNOWMAN_CONFIG_DIR`) with mode `0600`, and is never printed or logged. The key's server-side id is saved next to it, so `knowman logout` revokes the key (and says plainly if it could not reach the server, in which case you remove it in Settings → Connections), and a new `knowman login` revokes the key it replaces; an account holds at most 10 keys in total.

The sign-in listener remains open for at least 180 seconds and until the first valid callback arrives. The sign-in page stops accepting approval 120 seconds after it loads, so an expired page tells you to run `knowman login` again. The `--scopes` option accepts `agent` or `read`; `agent` is the default and requests the full agent key scopes, while `read` requests only search, ask, items:read, and memories:read. Any other value is rejected before anything starts. The device name shown on the page comes from the terminal and is not verified. On supported platforms the credential file is rejected if it is group- or world-readable or belongs to another user. Windows is not supported for stored credentials yet — the file is refused there, so set `KNOWMAN_API_KEY` instead. (Migration note for the npm 0.2.1 build, an older build: if a leftover `auth.json` exists that this version refuses to read — loose file modes — its key can never be read or revoked through the CLI. Delete it — `~/.config/knowman/auth.json`, `$XDG_CONFIG_HOME/knowman/auth.json`, `%APPDATA%\knowman\auth.json`, or `$KNOWMAN_CONFIG_DIR/auth.json` — then run `knowman login` again on a supported platform, or use `KNOWMAN_API_KEY`, and revoke the old key in Settings → Connections on app.knowman.io.) Saving uses a random temporary file with mode 0600 and an atomic rename. If the key cannot be saved, the CLI revokes it and exits with a non-zero status.

**`knowman-mcp` reads the same file.** After one `knowman login`, an MCP client config needs no `KNOWMAN_API_KEY` at all. Lookup order for both surfaces: `--api-key` (CLI only), then `KNOWMAN_API_KEY`, then `auth.json`. `KNOWMAN_API_URL` / `--api-url` override the URL stored in the file. Headless machine: the browser must run on the same machine as the CLI (the listener is local; `--no-browser` only stops the CLI opening it for you and prints the URL), so on a server use `KNOWMAN_API_KEY` instead.

`--format json` prints one compact JSON document for shell pipelines; list results are wrapped as `{"results": [...]}`, so `knowman search --query "pricing strategy" --format json | jq '.results[0].title'` works. Without it, output is pretty-printed JSON (`--json` keeps the compact, unwrapped form).

Run `knowman --help` for the full generated command list, or `knowman <command> --help` for one command:

<!-- cli-help:start (generated by "bun run docs:sync"; do not edit by hand) -->
```
KnowMan CLI

Usage:
  knowman <command> [options]

Account:
  login [--web-url <url>] [--api-url <url>] [--label <name>] [--no-browser] [--scopes agent|read]
    Sign in through your browser; the credential is shared with knowman-mcp.
  logout
    Revoke the saved key on the server and remove it.
  status
    Show whether you are signed in (never prints the key).

Global flags:
  --json
  --format <json|text>   json = one compact document; lists become {"results":[...]}
  --api-url <url>
  --api-key <key>
  --help
  --version

Commands (each also works without the kb- prefix, e.g. "save", "search"):
kb-research
  Retrieve ranked evidence across the user's whole library and distilled memories. Default tool for factual, strategic and how-to questions. Returns source passages, not an answer.
  --question <STRING>
  --max_passages <NUMBER> [optional]

kb-search
  Deprecated: use kb_research. Search saved items in the KnowMan Inbox, Knowledge Base, or Archive without returning content bodies; a location filter costs one extra lookup per hit. Every result carries `trust`: 'internal' is the user's OWN knowledge (their pages, documents and designated links) and outranks 'external' saved articles on anything about the user themselves. Returns snippets only; kb_get_item reads the full text.
  --query <STRING>
    Text to search for in KnowMan.
  --limit <NUMBER> [optional]
    Maximum number of search results to return.
  --location <STRING> [optional] (one of: inbox|kb|archive)
    Optional Inbox, Knowledge Base, or Archive location filter.
  --scope <STRING> [optional] (one of: internal|external|all)
    Which knowledge to search: 'internal' (the user's own pages, documents and designated links), 'external' (articles they saved), or 'all'. Defaults to all.

kb-ask
  Deprecated: use kb_research. Ask a question over the whole KnowMan library by default (Inbox and Knowledge Base; pass scope to narrow to kb or inbox), or a single item when itemId is given; returns an answer plus citations whose itemId resolves via kb_get_item. Answers specific questions with citations; may abstain on broad questions: then use kb_memories, kb_search and kb_get_item.
  --question <STRING>
    Question to ask over the KnowMan Knowledge Base.
  --item-id <STRING> [optional]
    Optional item id restricting the question.
  --project-id <STRING> [optional]
    Optional project id restricting the question.
  --scope <STRING> [optional] (one of: all|kb|inbox)
    Which part of the library to search: all (default): the whole library, Inbox and Knowledge Base; kb: Knowledge Base only; inbox: Inbox only. Ignored when itemId is given.

kb-get-item
  Read the full text of one saved item by id when research evidence needs more context.
  --id <STRING>
    KnowMan item id to retrieve.

kb-save
  Save a URL to the KnowMan Inbox or directly to the Knowledge Base. Pass trust:'internal' when the link is the user's own knowledge (their company docs, their own writing) rather than an outside article.
  --url <STRING>
    URL to save into KnowMan.
  --location <STRING> [optional] (one of: inbox|kb)
    Save into the Inbox or directly into the Knowledge Base.
  --note <STRING> [optional]
    Optional note to attach to the saved item.
  --trust <STRING> [optional] (one of: internal|external)
    Mark the saved link as the user's own knowledge ('internal' — their company docs, their own posts) rather than an outside article ('external', the default).

kb-recent
  List recently saved items. Use only when the user asks about recent saves.
  --limit <NUMBER> [optional]
    Maximum number of recent items to return.
  --location <STRING> [optional] (one of: inbox|kb)
    Optional Inbox or Knowledge Base location filter.
  --scope <STRING> [optional] (one of: internal|external|all)
    Which knowledge to list: 'internal', 'external', or 'all' (default).
  --source-type <ARRAY> [optional]
    Optional source type filter: manual, extension, rss, newsletter, inbox, or import. Array or comma-separated string. Use sourceType:['manual','extension'] to return only the user's own saves (manual and extension saves). Defaults to all types.

kb-memories
  Deprecated: use kb_research. List saved memories (claims, decisions, playbooks) from the Knowledge Base; use kind 'playbook' to find step-by-step processes the user has taught KnowMan. Read-only. Best first stop for process, strategy and how-to questions (kind 'playbook').
  --project <STRING> [optional]
    Optional project id as a UUID; project name lookup is unavailable.
  --kind <STRING> [optional] (one of: claim|decision|playbook)
    Optional memory kind: claim, decision, or playbook.
  --query <STRING> [optional]
    Optional case-insensitive title and body substring filter.
  --limit <NUMBER> [optional]
    Maximum number of memories to return.
```
<!-- cli-help:end -->

(The block above is generated from the tool registry by `bun run docs:sync`, and a test fails if it goes stale.)

## Create an API key

1. Open [app.knowman.io](https://app.knowman.io) → **Settings → Connections**.
2. In the **Connect an AI agent** card, press **Create agent key**. It mints a key with the five scopes the tools need and shows you ready-to-paste config for each client.
3. Copy the key immediately. Keys start with `km_`, are shown exactly once, and expire after 90 days by default.

To pick scopes by hand instead, use the **API Keys** list in the same tab.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "knowman": {
      "command": "npx",
      "args": ["-y", "@knowman/mcp"],
      "env": {
        "KNOWMAN_API_KEY": "km_..."
      }
    }
  }
}
```

Already ran `knowman login`? Drop the `env` block entirely; the server picks up the saved credential. Restart Claude Desktop. If it cannot resolve `npx`, give the absolute path to your Node installation's `npx` (`which npx`).

## Install in Claude Desktop

The desktop extension bundle (`.mcpb`) installs by double-click and shows the KnowMan logo. Build it first:

```
bun run pack:mcpb
```

This writes `dist/knowman.mcpb`.

1. Double-click `dist/knowman.mcpb`, or drag it into Claude Desktop under Settings → Extensions.
2. When asked, paste your KnowMan API key. Leave the API URL at its default unless KnowMan told you otherwise.

The API key is marked sensitive, so Claude Desktop stores it in the system keychain and not in a plain config file.

## Claude Code

```bash
claude mcp add knowman --env KNOWMAN_API_KEY=km_... -- npx -y @knowman/mcp
```

Or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "knowman": {
      "command": "npx",
      "args": ["-y", "@knowman/mcp"],
      "env": {
        "KNOWMAN_API_KEY": "km_..."
      }
    }
  }
}
```

Never commit a real key — use `${KNOWMAN_API_KEY}` and export it in your shell if the file is tracked.

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project):

```json
{
  "mcpServers": {
    "knowman": {
      "command": "npx",
      "args": ["-y", "@knowman/mcp"],
      "env": {
        "KNOWMAN_API_KEY": "km_..."
      }
    }
  }
}
```

Then enable **knowman** under Cursor Settings → MCP.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `KNOWMAN_API_KEY` | No (if you ran `knowman login`) | — | Bearer API key sent with every request; wins over the saved credential. The server exits with a message on stderr if neither exists. |
| `KNOWMAN_CONFIG_DIR` | No | `~/.config/knowman` | Directory holding the shared `auth.json`. |
| `KNOWMAN_APP_URL` | No | `https://app.knowman.io` | Web app used by `knowman login`. |
| `KNOWMAN_API_URL` | No | `https://api.knowman.io` | KnowMan public API base URL. |
| `KNOWMAN_MCP_DEBUG` | No | unset | Set to `1` for request and fallback diagnostics on stderr. |

### Blocked networks

Some ISPs (notably several Turkish carriers) do not resolve or reach `api.knowman.io`. Point the server at the direct host instead:

```json
"env": {
  "KNOWMAN_API_KEY": "km_...",
  "KNOWMAN_API_URL": "https://api-direct.knowman.io"
}
```

The direct host serves the same API with the same keys; it bypasses the CDN edge and is rate limited more tightly.

## Behaviour notes

- `kb_search` location filtering costs one extra item lookup per search hit because the search endpoint has no location filter.
- `kb_ask` returns `conversationId: null` because KnowMan API v1 exposes no conversation state.
- `kb_get_item` truncates readable content at 20,000 characters and reports whether truncation occurred.
- `kb_save` with `location: "kb"` makes two API calls: item creation followed by Knowledge Base membership.
- `kb_memories` sends the server's `kinds` parameter, not `kind`.
- `kb_memories` text queries request up to 100 summaries and filter title/body client-side.
- `kb_memories` with `kind: "playbook"` performs one detail lookup per returned memory.
- `kb_memories` project filtering requires a project UUID because API v1 has no project-name lookup.

## Verify an install

```bash
bash scripts/verify-install.sh            # the built bundle in this checkout (bun run build first)
bash scripts/verify-install.sh --from-npm # what `npx -y @knowman/mcp` installs for a real user
bash scripts/verify-install.sh mcp        # only the MCP server (or: cli)
```

Checks Node 22+, that the MCP server answers `initialize` + `tools/list` with the six `kb_*` tools, that the CLI reports a version and its commands, and whether you are signed in. It makes no KnowMan API call and prints no credential.

## Security notes

- The CLI waits up to 180 seconds for the browser callback. It exits right after a successful callback and releases the loopback port at once.
- Accepted residual risk: a second consent page for the same login that is still valid (under 120 seconds) could post its key to a local process that took the port after the CLI exited. This needs you to click Allow twice and a local attacker, who could already read the credentials file.
- The consent page expires 120 seconds after it first loads, including across the Google sign-in redirect. An expired page tells you to run `knowman login` again.
- Accepted low risk: a symlink swapped into the credentials directory between checks (directory symlink time-of-check/time-of-use). No code change.
- The credentials file is refused when it is loose (not 0600), foreign-owned, or a symlink. Its directory must be 0700 and owned by you.

## Telemetry and rate limits

Every request carries `X-KnowMan-Client` (`mcp/<version>` or `cli/<version>`) and `X-KnowMan-Tool`, so usage is attributable per surface. Agent traffic goes through the same Bearer-key path and the same rate-limit buckets as the web app and extensions; there is no exemption.

## Error messages

- Invalid or unauthorized key: `KnowMan API key rejected`
- Missing scope for the tool you called: `KnowMan API error 403: ...` — recreate the key with the scopes in the table above.
- Rate limit with retry value: `rate limited, retry in N s`
- Rate limit without usable retry value: `rate limited, retry later`
- Other HTTP errors: `KnowMan API error <status>: <message>`
- Invalid successful response: `KnowMan API returned a malformed response (<status>)`

## Development

```bash
bun test          # unit tests
bun run typecheck # tsc --noEmit
bun run build     # bundle src/index.ts -> dist/index.js (Node shebang, chmod +x)
bun run smoke     # build, then drive a real JSON-RPC initialize + tools/list over stdio
bun run inspect   # build, then validate with the official @modelcontextprotocol/inspector (needs network once)
bun run docs:sync # regenerate the CLI reference block above from the tool registry
npm pack --dry-run
```

`bun run build` bundles every dependency into `dist/index.js`, which is why the published manifest declares no runtime `dependencies`. `prepublishOnly` runs the build so a publish can never ship a stale bundle.
