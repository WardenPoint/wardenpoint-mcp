#!/usr/bin/env node
/**
 * Smoke run for the WardenPoint configuration MCP server.
 *
 * Speaks the real protocol over stdio to a real child process, against a real
 * stand — nothing here is mocked, because the point is to prove the three
 * joints that can quietly be wrong: the tool set really comes from the
 * description, the API key really authenticates, and a rejected call really
 * reaches the agent with the server's own wording intact.
 *
 * It creates one recipient and one observability integration and deletes both
 * again, so the account it runs against is left as it was found — with one
 * exception it cannot undo through the API: the alert posted in step 4e stays
 * in `external_alerts`, because deleting an integration does not delete the
 * alerts it received. Nothing lists it and nobody was paged for it, but a run
 * that must leave the database untouched has to remove that row by hand.
 *
 * Usage:
 *   WARDENPOINT_BASE_URL=https://127.0.0.1:8443 \
 *   WARDENPOINT_API_TOKEN=... \
 *   WARDENPOINT_ALLOW_INSECURE_TLS=1 \
 *   node smoke.js
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, 'bin', 'wardenpoint-mcp-server.js');

const line = (char = '-') => console.log(char.repeat(72));

function textOf(result) {
    return (result.content || [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

function jsonOf(result) {
    const text = textOf(result);
    const start = text.indexOf('\n');
    try {
        return JSON.parse(text.slice(start + 1));
    } catch {
        return null;
    }
}

function show(title, result) {
    line();
    console.log(title);
    line();
    console.log(`isError: ${result.isError === true}`);
    console.log(textOf(result));
    console.log();
}

const client = new Client({ name: 'wardenpoint-mcp-smoke', version: '0.1.0' }, { capabilities: {} });

const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: process.env,
    stderr: 'inherit',
});

await client.connect(transport);

let createdRecipient = null;
let createdIntegration = null;

try {
    // 1. The tool set.
    const { tools } = await client.listTools();
    line('=');
    console.log('STEP 1 — tools offered by the server');
    line('=');
    console.log(`tool count: ${tools.length}`);
    console.log(`first five: ${tools.slice(0, 5).map((tool) => tool.name).join(', ')}`);
    const secretTools = tools.filter((tool) => Object.hasOwn(tool.inputSchema.properties || {}, 'integration_secret'));
    console.log(`tools taking an integration secret: ${secretTools.map((tool) => tool.name).join(', ') || 'none'}`);
    console.log();

    // 2. What this account can actually do.
    const capabilities = await client.callTool({ name: 'v1_capabilities_index', arguments: {} });
    line('=');
    console.log('STEP 2 — v1_capabilities_index');
    line('=');
    console.log(`isError: ${capabilities.isError === true}`);

    const overview = jsonOf(capabilities);
    if (overview?.data) {
        const { channels = [], recipients, credentials_pending: pending } = overview.data;
        console.log(textOf(capabilities).split('\n')[0]);
        console.log(`channels described: ${channels.length}`);
        console.log('channel statuses:');
        for (const channel of channels) {
            console.log(`  ${channel.contact_type.padEnd(22)} ${String(channel.status).padEnd(14)} usable=${channel.usable}`);
        }
        console.log(`recipients: ${JSON.stringify(recipients)}`);
        if (pending !== undefined) {
            console.log(`credentials_pending: ${JSON.stringify(pending)}`);
        }
    } else {
        console.log(textOf(capabilities));
    }
    console.log();

    // 3. Create a recipient, give it a contact, read it back.
    const created = await client.callTool({
        name: 'v1_recipients_store',
        arguments: { body: { name: 'MCP smoke run (delete me)' } },
    });
    show('STEP 3a — v1_recipients_store', created);

    createdRecipient = jsonOf(created)?.data?.uuid ?? null;
    console.log(`created recipient uuid: ${createdRecipient}`);
    console.log();

    if (!createdRecipient) {
        throw new Error('The create call did not return a uuid; the rest of the run would be meaningless.');
    }

    const contact = await client.callTool({
        name: 'v1_recipient_contacts_store',
        arguments: {
            recipient: createdRecipient,
            body: {
                contact_type: 'email',
                value: 'mcp-smoke@wardenpoint.dev',
                is_primary: true,
                label: 'smoke run',
            },
        },
    });
    show('STEP 3b — v1_recipient_contacts_store', contact);

    const readBack = await client.callTool({
        name: 'v1_recipients_show',
        arguments: { recipient: createdRecipient },
    });
    show('STEP 3c — v1_recipients_show (read back)', readBack);

    // 4. Two ways to be wrong, and what the agent is told about them.
    const missing = await client.callTool({
        name: 'v1_recipients_show',
        arguments: { recipient: '00000000-0000-4000-8000-000000000000' },
    });
    show('STEP 4a — v1_recipients_show with a uuid that does not exist', missing);

    const invalid = await client.callTool({
        name: 'v1_recipient_contacts_store',
        arguments: {
            recipient: createdRecipient,
            body: { contact_type: 'email', value: 'definitely-not-an-email' },
        },
    });
    show('STEP 4b — v1_recipient_contacts_store with a value that fails validation', invalid);

    // 4c. The other credential. A real integration is created so that the
    // rejection is the secret being wrong, not the integration being absent.
    const integration = await client.callTool({
        name: 'v1_observability_integrations_store',
        arguments: {
            body: { name: 'MCP smoke run (delete me)', type: 'generic_webhook', preset: 'notify_every_alert' },
        },
    });
    show('STEP 4c — v1_observability_integrations_store (to have a secret to be wrong about)', integration);

    const integrationBody = jsonOf(integration)?.data;
    createdIntegration = integrationBody?.uuid ?? null;
    const realSecret = integrationBody?.secret ?? integrationBody?.plain_secret ?? null;
    console.log(`created integration uuid: ${createdIntegration}, secret returned: ${realSecret ? 'yes' : 'no'}`);
    console.log();

    if (createdIntegration) {
        const wrongSecret = await client.callTool({
            name: 'v1_integration_alerts_store',
            arguments: {
                integration: createdIntegration,
                integration_secret: 'definitely-not-the-secret',
                body: { title: 'smoke', severity: 'info' },
            },
        });
        show('STEP 4d — v1_integration_alerts_store with a wrong integration secret', wrongSecret);
    }

    if (createdIntegration && realSecret) {
        // The same call with the right secret: 202 proves the webhook is live,
        // and `queue_skip_reason` says why nobody was paged — which on an empty
        // account is the expected answer, not a failure.
        const accepted = await client.callTool({
            name: 'v1_integration_alerts_store',
            arguments: {
                integration: createdIntegration,
                integration_secret: realSecret,
                body: {
                    external_alert_id: 'mcp-smoke-1',
                    title: 'MCP smoke run',
                    severity: 'info',
                    status: 'firing',
                },
            },
        });
        show('STEP 4e — v1_integration_alerts_store with the real integration secret', accepted);
    }
} finally {
    // 5. Leave the account as empty as it was found.
    if (createdIntegration) {
        const removed = await client.callTool({
            name: 'v1_observability_integrations_destroy',
            arguments: { integration: createdIntegration },
        });
        show('STEP 5 — v1_observability_integrations_destroy (cleanup)', removed);
    }

    if (createdRecipient) {
        const removed = await client.callTool({
            name: 'v1_recipients_destroy',
            arguments: { recipient: createdRecipient },
        });
        show('STEP 5b — v1_recipients_destroy (cleanup)', removed);
    }

    const left = await client.callTool({ name: 'v1_recipients_index', arguments: {} });
    show('STEP 5c — v1_recipients_index (the account should be empty again)', left);

    await client.close();
}
