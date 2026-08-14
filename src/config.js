const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function readConfig(env = process.env) {
    const baseUrl = (env.WARDENPOINT_BASE_URL || '').trim().replace(/\/+$/, '');
    const apiToken = (env.WARDENPOINT_API_TOKEN || '').trim();
    const allowInsecureTls = TRUTHY.has(String(env.WARDENPOINT_ALLOW_INSECURE_TLS || '').toLowerCase());
    const timeoutMs = Number.parseInt(env.WARDENPOINT_TIMEOUT_MS || '30000', 10);

    return {
        baseUrl,
        apiToken,
        allowInsecureTls,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
        specPath: env.WARDENPOINT_OPENAPI_PATH || null,
        // Какие инструменты объявлять. Пусто — все.
        toolFilter: (env.WARDENPOINT_TOOLS || '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    };
}

/**
 * Enough configuration to ask the installation to describe itself.
 *
 * Separate from {@see assertUsable} because the two happen at different
 * moments now: the description is fetched before any tool exists, and it is
 * public — no token involved. Demanding a token here would mean `--list-tools`
 * refuses to run for somebody who has not issued one yet, which is exactly the
 * person most likely to be looking.
 *
 * Skipped entirely when WARDENPOINT_OPENAPI_PATH points at a local file.
 */
export function assertCanReachInstallation(config) {
    if (config.specPath) {
        return;
    }

    if (!config.baseUrl) {
        throw new Error(
            'Cannot start the WardenPoint MCP server:\n' +
            '- WARDENPOINT_BASE_URL is not set (e.g. https://wardenpoint.com). ' +
            'The server reads the API description from the installation it configures.',
        );
    }

    if (!/^https?:\/\//.test(config.baseUrl)) {
        throw new Error(
            `Cannot start the WardenPoint MCP server:\n- WARDENPOINT_BASE_URL must start ` +
            `with http:// or https://, got "${config.baseUrl}".`,
        );
    }
}

/** Refuse to serve half-configured rather than failing on the first call. */
export function assertUsable(config) {
    const problems = [];

    if (!config.baseUrl) {
        problems.push('WARDENPOINT_BASE_URL is not set (e.g. https://wardenpoint.com).');
    } else if (!/^https?:\/\//.test(config.baseUrl)) {
        problems.push(`WARDENPOINT_BASE_URL must start with http:// or https://, got "${config.baseUrl}".`);
    }

    if (!config.apiToken) {
        problems.push('WARDENPOINT_API_TOKEN is not set; every API-key operation would answer 401.');
    }

    if (problems.length > 0) {
        throw new Error(`Cannot start the WardenPoint MCP server:\n- ${problems.join('\n- ')}`);
    }
}
