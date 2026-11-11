# Install KnowMan MCP server

This guide is for an AI agent (Cline) installing the KnowMan MCP server. It runs a stdio MCP server, `@knowman/mcp`, that searches, asks, saves and reads items in a KnowMan account.

## Requirements

- Node.js 22 or newer. Check with `node --version`.
- A KnowMan account and an API key. The user creates the key; the agent does not.

## Steps

1. Ask the user for a KnowMan API key. The user creates one at https://app.knowman.io under Settings, then API keys. Do not invent or print the key. Store it only in the MCP settings `env` block.
2. Add this server to the MCP settings file (`cline_mcp_settings.json`) under `mcpServers`:

```json
{
  "mcpServers": {
    "knowman": {
      "command": "npx",
      "args": ["-y", "@knowman/mcp"],
      "env": {
        "KNOWMAN_API_KEY": "<the user's key>"
      }
    }
  }
}
```

3. Save the settings file. Cline starts the server with `npx`, which downloads `@knowman/mcp` on first run.
4. Check the connection. The server must list six tools: `kb_search`, `kb_ask`, `kb_save`, `kb_get_item`, `kb_recent` and `kb_memories`.
5. Test one read-only call, for example `kb_recent` with `limit` 3. A result list, even an empty one, means the key works. An authentication error means the key is wrong or revoked: ask the user for a new key.

## Optional: sign in with the browser instead of a key

Run `npm install -g @knowman/mcp`, then `knowman login`. The saved credential is shared with the `knowman-mcp` command, so the `env` block can be left out. Run `knowman status` to confirm sign-in. Never print the stored key.

## Optional: hosted remote server

Clients that accept remote MCP servers can connect to `https://api.knowman.io/mcp` (Streamable HTTP) instead. The hosted server exposes four tools: `kb_research`, `kb_get_item`, `kb_recent` and `kb_save`. Use header `Authorization: Bearer <key>`, or complete the OAuth 2.1 consent flow in the browser if the client supports it.

## Troubleshooting

- `npx` not found: install Node.js 22 or newer.
- Authentication error: create a new API key in KnowMan settings and replace the old one.
- No tools listed: restart the MCP server from the Cline MCP panel and check the settings file is valid JSON.
