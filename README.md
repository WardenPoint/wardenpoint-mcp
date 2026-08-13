# WardenPoint MCP server

An [MCP](https://modelcontextprotocol.io) server that lets an agent configure a
[WardenPoint](https://wardenpoint.com) account — recipients, contacts, groups,
notification rules, escalation policies, on-call schedules, alert-source
integrations, routing rules and telephony — without anyone opening the
dashboard.

It speaks stdio and exposes **one tool per operation of your installation's own
OpenAPI description**.

```json
{
  "mcpServers": {
    "wardenpoint": {
      "command": "npx",
      "args": ["-y", "@wardenpoint/mcp-server"],
      "env": {
        "WARDENPOINT_BASE_URL": "https://wardenpoint.com",
        "WARDENPOINT_API_TOKEN": "wp_live_..."
      }
    }
  }
}
```

That is the whole installation. Your MCP client starts the server on demand;
nothing runs between sessions.

## The one rule this server exists to keep

**There is no second copy of the contract here.**

Every tool — its name, its text, its arguments, their descriptions, their enums
and bounds, the responses it can answer with — is read at startup from the
OpenAPI description **served by the installation you are configuring**
(`GET {WARDENPOINT_BASE_URL}/docs`). Nothing about the API is restated in this
package.

That is deliberate, and it is why the tools cannot quietly drift:

- an endpoint added to your installation appears as a tool the next time the
  server starts — no package upgrade involved;
- a description reworded upstream rewords the agent's instructions with it;
- an operation nobody described is invisible to the agent, which is the correct
  failure and the reason `--spec-report` exists.

A description bundled inside this package would describe whatever was current
when the package was published, while the agent talks to whatever you actually
run. There is no offline fallback for the same reason: every tool here is an
HTTP call to that installation, so if it cannot be reached, a complete tool list
would be a list of things that cannot be done.

## Requirements

Node 20 or newer. No build step, no native modules.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `WARDENPOINT_BASE_URL` | yes | Origin of the installation — no trailing slash, no `/api/v1` suffix. The description carries full paths. |
| `WARDENPOINT_API_TOKEN` | to call | A company API key from **Dashboard → Integrations → API keys**. Sent as `X-API-Key`. Not needed for `--list-tools` or `--spec-report`. |
| `WARDENPOINT_ALLOW_INSECURE_TLS` | no | `1` disables certificate verification. **Development stands only** — never against production. |
| `WARDENPOINT_TIMEOUT_MS` | no | Per-request timeout, default `30000`. |
| `WARDENPOINT_OPENAPI_PATH` | no | Read the description from a local file instead of the installation. For developing against a description that is not deployed yet. |

The token is read from the environment at every start and is never written
anywhere by this package.

### What the key is allowed to do

Abilities are chosen when you issue the key, and a 403 names the one that was
missing:

- `config.read` — read the whole configuration. A good place to start: the
  agent can explain an account somebody else built and change nothing.
- `config.write` — create, update, delete.
- `notifications.send` / `notifications.read` — fire alerts and inspect them.

**No ability can read a secret.** There is no such ability in the vocabulary, so
it cannot be granted by mistake. The API reports whether a credential is set and
whether it verified — never its value.

## Running

```bash
npx -y @wardenpoint/mcp-server --list-tools     # every tool, with its arguments
npx -y @wardenpoint/mcp-server --spec-report    # gaps in the description itself
```

Both talk to `WARDENPOINT_BASE_URL` to fetch the description; neither needs a
token. Without arguments the process speaks MCP over stdio and is meant to be
started by a client, not by hand.

## Two credentials, and why they are not interchangeable

- **API key** (`WARDENPOINT_API_TOKEN`) — who you are. Every configuration tool
  uses it.
- **Integration secret** — proves a specific alert-source webhook is genuine.
  Two tools accept it as an argument; it is not read from the environment and
  not stored here.

## What this server deliberately cannot do

Two steps in setting up an account need a human at a screen, and both stay that
way on purpose:

- **Scanning a Telegram QR code.**
- **Typing a provider secret.**

For each, the agent asks the installation to issue a one-time link, shows it to
the person, and polls for the result. The person opens that link in the
dashboard, behind their own login, and types the value themselves. Ask an agent
to relay a secret through the conversation and it will refuse — that is what the
link exists to avoid.

## Errors reach the agent intact

The API spends real effort explaining refusals — which ability was missing,
which field failed validation, why a send queued nothing. This server passes the
body through whole, on success and failure alike, because an agent repairs
itself from that text and nothing else.

## Licence

MIT. See [LICENSE](LICENSE).

Issues and contributions: <https://github.com/WardenPoint/wardenpoint-mcp>.
