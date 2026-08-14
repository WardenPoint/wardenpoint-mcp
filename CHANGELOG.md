# Changelog

## 0.1.2 — 2026-08-14

Discoverability, no behaviour change.

- Published to the official MCP Registry, so MCP clients and directories can
  find the server instead of only people who already know the package name.
  `server.json` describes it; `mcpName` in `package.json` is what the registry
  checks to confirm the npm package is ours.
- Both publishes now happen in the same release, from the same identity, with
  no stored token: npm via OIDC trusted publishing, the registry via GitHub
  OIDC. The registry step runs last on purpose — npm keeps a version forever,
  so nothing should reach it after a step that can fail.

## 0.1.1 — 2026-08-14

**0.1.0 could not start against a production WardenPoint. Upgrade.**

It read the description from `GET {WARDENPOINT_BASE_URL}/docs`, a path served
by `l5-swagger` — which is a *development* dependency of the application. A
production image is built without it, so that address does not exist there.
The failure was invisible in development, where the package is installed.

- The description is now read from `/api/openapi.json`, served by WardenPoint's
  own code in every environment. `/docs` is still tried afterwards so an older
  installation keeps working, and a failure names every address it tried.
- The packaging test now asserts that both addresses are attempted. Nothing in
  0.1.0 would have caught the original mistake.

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
