# Changelog

All notable changes to `@knowman/mcp` are listed here. Earlier releases are not recorded in this file.

## 0.3.1

### Removed

- Removed the MCP Apps "cards" UI bundle, including the source under `ui/`, the bundle build script, the render script, and the generated HTML module. The hosted KnowMan MCP server stopped rendering cards in its last release, so the stdio package no longer ships the bundle either.
- The `ui://knowman/cards.html` resource is no longer registered.
- Tools no longer send the `_meta.ui` field.
- Removed two development-only dependencies, `@modelcontextprotocol/ext-apps` and `happy-dom`. Only the removed bundle and its tests used them.

### Added

- `kb_research` is available on the stdio package. It is the same tool the hosted server exposes.

### Changed

- `manifest.json` lists all seven tools, with the three deprecated ones marked.
- Tool results still include `structuredContent` where they did before.

### Deprecated

- `kb_search`, `kb_ask` and `kb_memories` still work on the stdio package. Use `kb_research` instead. They are already gone from the hosted server, and they will be removed from this package in a later release.

### Not changed

- No tool input or output shape changed for `kb_research`, `kb_get_item`, `kb_recent` or `kb_save`.
- The package is not published by this change. Publishing needs the founder's approval.