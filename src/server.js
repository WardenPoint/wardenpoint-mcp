import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from './http.js';
import { buildTools } from './tools.js';
import { resolveSpec } from './spec.js';

/**
 * Render an HTTP answer for the agent.
 *
 * The body is passed through whole, on success and on failure alike. The API
 * spends real effort saying what went wrong — «API key lacks the config.write
 * ability», the field that failed validation, the reason a webhook queued
 * nothing — and an agent repairs itself from that text and nothing else.
 * Collapsing it into "request failed" would throw the work away.
 */
export function renderResponse(response) {
    const status = `HTTP ${response.status} ${response.statusText}`.trim();
    const body = response.text ?? '';

    let rendered = body;
    try {
        rendered = body.length > 0 ? JSON.stringify(JSON.parse(body), null, 2) : '(empty response body)';
    } catch {
        rendered = body.length > 0 ? body : '(empty response body)';
    }

    return {
        content: [{ type: 'text', text: `${status}\n\n${rendered}` }],
        isError: response.status >= 400,
    };
}

export function createServer({ config, spec, tools }) {
    const client = new ApiClient(config);
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

    const server = new Server(
        {
            name: 'wardenpoint-config',
            version: '0.1.0',
        },
        {
            capabilities: { tools: {} },
            instructions:
                `Configuration API of WardenPoint (${spec.info?.title || 'WardenPoint API'} ${spec.info?.version || ''}).`.trim() +
                ' Every tool here is one operation of the published OpenAPI description, and its wording is that' +
                ' description verbatim — read a tool\'s text before calling it, especially the notes about what a' +
                ' missing field does and what is merged rather than replaced. Objects are addressed by UUID, never' +
                ' by numeric id. Two things cannot be done through this server because they need a human at a' +
                ' screen: scanning a Telegram QR code, and typing a provider secret. For both, ask for a link' +
                ' (`v1_credential_requests_store`, `v1_credentials_telegram_qr_store`), show it to the person and' +
                ' then poll for the state. Never ask a person to paste a secret into this conversation.',
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: tools.map((tool) => tool.definition),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const tool = byName.get(request.params.name);

        if (!tool) {
            return {
                content: [{ type: 'text', text: `Unknown tool "${request.params.name}".` }],
                isError: true,
            };
        }

        try {
            const response = await client.call(tool, request.params.arguments || {});
            return renderResponse(response);
        } catch (error) {
            const hint = /self-signed|SELF_SIGNED|certificate/i.test(String(error?.message))
                ? '\n\nThe server presented a certificate this client does not trust. On a development stand,' +
                  ' start the MCP server with WARDENPOINT_ALLOW_INSECURE_TLS=1.'
                : '';

            return {
                content: [{ type: 'text', text: `The request could not be completed: ${error?.message || error}${hint}` }],
                isError: true,
            };
        }
    });

    return server;
}

/**
 * Load the description and turn it into a ready server plus its build report.
 *
 * Asynchronous because the description now comes from the installation itself
 * ({@see resolveSpec}) rather than from a file next to this code.
 */
/**
 * Оставить только запрошенные инструменты.
 *
 * Полный список — 89 инструментов и около 250 КБ, то есть примерно 64 тысячи
 * токенов, и грузится он в каждую сессию ДО того, как человек скажет первое
 * слово. На окне в 200 тысяч это треть контекста, потраченная на инструменты,
 * половина которых в разговоре не понадобится.
 *
 * Шаблон — подстрока или glob по имени инструмента: `recipients` оставит все
 * `v1_recipients_*`, `v1_schedules_*` — только графики. Пустой список
 * означает «все», то есть прежнее поведение: сужать набор молча нельзя,
 * пропавший инструмент выглядит как отсутствующая возможность продукта.
 *
 * @param {Array} tools
 * @param {string[]} patterns
 */
function selectTools(tools, patterns) {
    if (patterns.length === 0) {
        return tools;
    }

    const matchers = patterns.map((pattern) => {
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(escaped);
    });

    return tools.filter((tool) => matchers.some((re) => re.test(tool.definition.name)));
}

export async function bootstrap(config) {
    const { spec, specPath } = await resolveSpec(config);
    const built = buildTools(spec);
    const { findings, excluded } = built;
    const tools = selectTools(built.tools, config.toolFilter || []);

    if (tools.length === 0 && built.tools.length > 0) {
        throw new Error(
            `WARDENPOINT_TOOLS matched none of the ${built.tools.length} available tools. ` +
            'Patterns are matched against tool names such as v1_recipients_store; ' +
            'run --list-tools with WARDENPOINT_TOOLS unset to see them all.',
        );
    }

    return {
        spec,
        specPath,
        tools,
        findings,
        excluded,
        server: createServer({ config, spec, tools }),
    };
}
