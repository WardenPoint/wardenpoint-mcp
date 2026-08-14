#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assertCanReachInstallation, assertUsable, readConfig } from '../src/config.js';
import { bootstrap } from '../src/server.js';

const args = new Set(process.argv.slice(2));
const config = readConfig();

/**
 * What the tool list costs the model's context.
 *
 * Every tool definition is sent to the model before the person says anything,
 * so this is spent whether or not the conversation ever touches WardenPoint.
 * The full set is around 64k tokens; on a 200k window that is a third of it.
 * Saying the number out loud is what makes WARDENPOINT_TOOLS worth reaching
 * for — an invisible cost is one nobody trims.
 */
function describeWeight(tools) {
    const bytes = JSON.stringify(tools.map((tool) => tool.definition)).length;
    const approxTokens = Math.round(bytes / 4 / 1000);

    return `~${approxTokens}k tokens of context; narrow it with WARDENPOINT_TOOLS`;
}

function groupFindings(findings) {
    const grouped = new Map();

    for (const finding of findings) {
        if (!grouped.has(finding.kind)) {
            grouped.set(finding.kind, []);
        }
        grouped.get(finding.kind).push(finding);
    }

    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
}

try {
    // The description now comes from the installation, so its address is
    // needed before anything can be built — including the two reporting
    // switches below, which used to work with no configuration at all.
    // The token is not: describing yourself is public, calling is not.
    assertCanReachInstallation(config);

    const { tools, findings, excluded, specPath, server } = await bootstrap(config);

    if (args.has('--list-tools')) {
        for (const tool of tools) {
            const inputs = Object.keys(tool.definition.inputSchema.properties).join(', ') || '-';
            process.stdout.write(`${tool.definition.name}\t${tool.method.toUpperCase()} ${tool.path}\t[${inputs}]\n`);
        }
        process.stdout.write(`\n${tools.length} tools from ${specPath}\n`);
        process.stdout.write(`${describeWeight(tools)}\n`);
        process.exit(0);
    }

    if (args.has('--spec-report')) {
        process.stdout.write(`OpenAPI description: ${specPath}\n`);
        process.stdout.write(`Tools built: ${tools.length}\n`);
        process.stdout.write(`Operations excluded on purpose: ${excluded.length}\n`);

        for (const item of excluded) {
            process.stdout.write(`  - ${item.method.toUpperCase()} ${item.path} — ${item.reason}\n`);
        }

        process.stdout.write(`\nDescription gaps found while building (${findings.length}):\n`);

        for (const [kind, items] of groupFindings(findings)) {
            process.stdout.write(`\n## ${kind} (${items.length})\n`);
            for (const item of items) {
                process.stdout.write(`  - ${item.operation}: ${item.detail}\n`);
            }
        }

        process.exit(0);
    }

    assertUsable(config);

    // stdio is the protocol channel; every human-readable word goes to stderr.
    process.stderr.write(
        `wardenpoint-mcp-server: ${tools.length} tools (${describeWeight(tools)}) from ${specPath}, base ${config.baseUrl}` +
        `${config.allowInsecureTls ? ', TLS verification DISABLED' : ''}` +
        `${findings.length > 0 ? `, ${findings.length} description gaps (see --spec-report)` : ''}\n`,
    );

    await server.connect(new StdioServerTransport());
} catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exit(1);
}
