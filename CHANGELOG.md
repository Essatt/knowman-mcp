# Changelog

All notable changes to `@knowman/mcp` are listed here. Earlier releases are not recorded in this file.

## 0.3.3 (2026-11-14)

Version 0.3.2 carried wrong package metadata: license `UNLICENSED`, the private repository URL, and no `mcpName`. Version 0.3.3 supersedes it and contains the same code as 0.3.2 with the correct public metadata.

## 0.3.2

### Fixed

- `kb_ask` searched only Knowledge Base members and often abstained on questions the app answers, because it sent no `sources` field and the API then defaults to Knowledge Base only. It now sends an explicit scope: the whole library by default.

### Added

- `kb_ask` takes an optional `scope` input: `all` (default, Inbox and Knowledge Base), `kb` (Knowledge Base only) or `inbox` (Inbox only). The payload matches the web app's Ask scope. `scope` is ignored when `itemId` is given, and that case is unchanged.

### Not changed

- The API default for `POST /api/v1/ask` is unchanged. Other clients still send their own scope.

## 0.3.1

### Removed

- Removed the MCP Apps "cards" UI bundle, including the source under `ui/`, the bundle build script, the render script, and the generated HTML module. The hosted KnowMan MCP server stopped rendering cards in its last release, so the stdio package no longer ships the bundle either.
- The last file of the old `src/ui/` module, `search-app.ts`, is removed. Its `structuredContentFor` function moved unchanged to `src/structured-content.ts`, which the public mirror also ships. The `CARDS_APP_URI` and `CLAUDE_REMOTE_UI_DOMAIN` constants are removed because nothing imported them except the removed module and its test.
- The `ui://knowman/cards.html` resource is no longer registered.
- Tools no longer send the `_meta.ui` field.
- Removed two development-only dependencies, `@modelcontextprotocol/ext-apps` and `happy-dom`. Only the removed bundle and its tests used them.

### Changed

- `manifest.json` lists all seven tools, with the three deprecated ones marked.
- Tool results still include `structuredContent` where they did before.

### Deprecated

- `kb_search`, `kb_ask` and `kb_memories` still work on the stdio package. Use `kb_research` instead. They are already gone from the hosted server, and they will be removed from this package in a later release.

### Not changed

- No tool input or output shape changed for `kb_research`, `kb_get_item`, `kb_recent` or `kb_save`.
