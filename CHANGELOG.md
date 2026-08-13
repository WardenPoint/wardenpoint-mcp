# Changelog

## 0.1.0 — 2026-08-14

First public release.

- One MCP tool per operation of the installation's own OpenAPI description,
  fetched over HTTP at startup from `GET {WARDENPOINT_BASE_URL}/docs`. Nothing
  about the API is restated in this package, and there is no bundled copy of the
  description to drift out of date.
- `--list-tools` and `--spec-report` for inspecting what the agent will see, and
  what the description fails to say. Neither needs an API key.
- Secrets are out of reach by construction: no ability grants reading them, and
  writing one goes through a one-time link a human opens in the dashboard.
- Errors from the API are passed through whole — an agent repairs itself from
  that text and nothing else.
