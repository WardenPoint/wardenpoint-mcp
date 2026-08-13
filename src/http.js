import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTEGRATION_SECRET_PROPERTY } from './tools.js';

/**
 * How the installation recognises traffic from this server.
 *
 * Name and version are read from `package.json` rather than written here:
 * a hand-kept copy is how a header ends up claiming 0.1 forever. It is the
 * only signal by which the installation can tell «configured by an agent»
 * from «integrated by hand», so it has to stay true.
 */
const USER_AGENT = (() => {
    try {
        const manifest = JSON.parse(readFileSync(
            resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
            'utf8',
        ));

        return `${manifest.name}/${manifest.version}`;
    } catch {
        return '@wardenpoint/mcp-server';
    }
})();

/**
 * `AuthenticateWithApiKey::getTokenFromRequest()` accepts either
 * `Authorization: Bearer <token>` or `X-API-Key: <token>`. The description
 * names `X-API-Key` in its `apiKey` security scheme, so that is what we send:
 * it is the form the contract commits to, and it leaves `Authorization`
 * unambiguously to the integration secret, which is bearer-only.
 */
const API_KEY_HEADER = 'X-API-Key';

export class ApiClient {
    constructor(config) {
        this.config = config;
        this.agents = new Map();
    }

    agentFor(protocol) {
        if (!this.agents.has(protocol)) {
            this.agents.set(
                protocol,
                protocol === 'https:'
                    ? new https.Agent({ keepAlive: true, rejectUnauthorized: !this.config.allowInsecureTls })
                    : new http.Agent({ keepAlive: true }),
            );
        }

        return this.agents.get(protocol);
    }

    /**
     * Turn one tool call into one HTTP request.
     *
     * Path parameters are substituted, query parameters appended, and whatever
     * is left in `body` is sent as JSON. The tool schema decides which is
     * which, and the tool schema came from the description.
     */
    buildRequest(tool, args) {
        const values = args && typeof args === 'object' ? args : {};
        let path = tool.path;
        const query = new URLSearchParams();

        for (const parameter of tool.parameters) {
            const value = values[parameter.name];

            if (parameter.in === 'path') {
                if (value === undefined || value === null || value === '') {
                    throw new Error(`Missing required path parameter "${parameter.name}" for ${tool.definition.name}.`);
                }

                path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
                continue;
            }

            if (value === undefined || value === null) {
                continue;
            }

            if (Array.isArray(value)) {
                for (const item of value) {
                    query.append(`${parameter.name}[]`, String(item));
                }
            } else if (typeof value === 'object') {
                query.append(parameter.name, JSON.stringify(value));
            } else {
                query.append(parameter.name, String(value));
            }
        }

        const unresolved = path.match(/\{([^}]+)\}/);
        if (unresolved) {
            throw new Error(`Path placeholder "{${unresolved[1]}}" of ${tool.definition.name} has no matching parameter in the API description.`);
        }

        const url = new URL(this.config.baseUrl + path);
        for (const [key, value] of query) {
            url.searchParams.append(key, value);
        }

        const headers = {
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
        };

        if (tool.schemes.includes('integrationSecret')) {
            const secret = values[INTEGRATION_SECRET_PROPERTY];

            if (!secret) {
                throw new Error(
                    `${tool.definition.name} authenticates with an integration secret; ` +
                    `pass it as "${INTEGRATION_SECRET_PROPERTY}".`,
                );
            }

            headers.Authorization = `Bearer ${secret}`;
        } else if (tool.schemes.includes('apiKey')) {
            headers[API_KEY_HEADER] = this.config.apiToken;
        }

        let payload;
        if (tool.hasBody && values.body !== undefined) {
            payload = JSON.stringify(values.body);
            headers['Content-Type'] = 'application/json';
        }

        return { url, headers, payload, method: tool.method.toUpperCase() };
    }

    async call(tool, args) {
        const { url, headers, payload, method } = this.buildRequest(tool, args);

        return await new Promise((resolve, reject) => {
            const transport = url.protocol === 'https:' ? https : http;

            const request = transport.request(
                url,
                { method, headers, agent: this.agentFor(url.protocol) },
                (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () => {
                        resolve({
                            status: response.statusCode,
                            statusText: response.statusMessage || '',
                            headers: response.headers,
                            text: Buffer.concat(chunks).toString('utf8'),
                            request: { method, url: url.toString() },
                        });
                    });
                },
            );

            request.setTimeout(this.config.timeoutMs, () => {
                request.destroy(new Error(`Request timed out after ${this.config.timeoutMs} ms: ${method} ${url}`));
            });

            request.on('error', reject);

            if (payload !== undefined) {
                request.write(payload);
            }

            request.end();
        });
    }
}

export { API_KEY_HEADER };
