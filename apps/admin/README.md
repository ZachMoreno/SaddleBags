# apps/admin — the Admin (milestone 4)

The web app where a mixed team manages its plugins. Planned views:

- **Rules**: every rule with its condition kind, directive kind, `authoredBy`, and
  `editableIn`. Domain experts edit prose overlays here.
- **Memory**: browse memory by org / group / user, and review pending proposals.
- **Traces**: for each operation, which rules fired and why, plus attempts and rejections.
- **Releases**: RC → eval report → promote / unpublish.
- **Library**: pre-baked artifacts awaiting approval.

License: AGPL-3.0-only.

MCP (from milestone 3, §4.11 of the spec) adds:

- **Connections**: connect the MCP servers each plugin declares, at org, group or
  user scope (OAuth or API token).
- **Drift**: see which plugins' pinned MCP tools changed, and re-pin through evals.
- **API tokens**: mint and revoke scoped tokens for the `/mcp` endpoint.
