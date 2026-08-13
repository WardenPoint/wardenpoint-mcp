import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

/**
 * The description is the single source of truth for this server. Nothing about
 * the API is restated here — if an operation, a parameter or a wording is
 * missing from it, it is missing from the agent's view too, and that is the
 * intended failure mode.
 *
 * ## Where it comes from
 *
 * From the installation you are configuring, over HTTP, at startup. Not from a
 * copy shipped inside this package.
 *
 * That is deliberate and it is the whole point. A bundled copy would describe
 * the version of WardenPoint that happened to be current when this package was
 * published, while the agent would be talking to whatever the customer actually
 * runs. The moment those differ, the agent is told about an endpoint that isn't
 * there, or not told about one that is — and it has no way to notice. Fetching
 * means the tools always match the server answering them.
 *
 * There is no offline fallback, and that costs nothing: every tool this server
 * exposes is an HTTP call to that same installation. If it cannot be reached,
 * a complete list of tools would be a list of things that cannot be done.
 * Failing at startup with a clear reason beats starting up useful-looking.
 *
 * `WARDENPOINT_OPENAPI_PATH` still overrides everything, for developing against
 * a description that has not been deployed yet.
 */
/**
 * Where the installation publishes its description, newest path first.
 *
 * `/api/openapi.json` is served by WardenPoint's own code and exists in every
 * environment. `/docs` comes from `l5-swagger`, which lives in the
 * application's dev dependencies — so it answers on a development stand and
 * does NOT exist in production. Version 0.1.0 of this package knew only that
 * path and therefore could not start against a real installation at all.
 *
 * Both are tried so an older installation keeps working; the first that
 * answers wins, and the failure message names every address that was tried.
 */
const SPEC_ENDPOINTS = ['/api/openapi.json', '/docs'];

export function loadSpecFromFile(specPath) {
    let raw;
    try {
        raw = readFileSync(specPath, 'utf8');
    } catch (error) {
        throw new Error(
            `Cannot read the OpenAPI description at ${specPath}. ` +
            'Run `php artisan l5-swagger:generate` in the application, or unset ' +
            'WARDENPOINT_OPENAPI_PATH to read it from the installation instead. ' +
            'Original error: ' + error.message,
        );
    }

    return { spec: assertUsableSpec(JSON.parse(raw), specPath), specPath };
}

/**
 * Ask the installation to describe itself.
 *
 * TLS policy is the same one the tool calls use — a development stand behind a
 * self-signed certificate must not be reachable for calls but unreachable for
 * the description that makes those calls possible.
 */
export function fetchSpecFrom(config, endpoint) {
    const url = new URL(config.baseUrl + endpoint);
    const transport = url.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const request = transport.get(
            url,
            {
                timeout: config.timeoutMs,
                rejectUnauthorized: url.protocol !== 'https:' || !config.allowInsecureTls,
                headers: { Accept: 'application/json' },
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');

                    if (response.statusCode !== 200) {
                        reject(new Error(
                            `${url} answered ${response.statusCode}. ` +
                            'That address must serve the OpenAPI description as JSON. ' +
                            'Check WARDENPOINT_BASE_URL points at the WardenPoint installation ' +
                            'itself (no /api/v1 suffix).',
                        ));
                        return;
                    }

                    let parsed;
                    try {
                        parsed = JSON.parse(body);
                    } catch (error) {
                        reject(new Error(
                            `${url} did not return JSON. A proxy or a login page may be ` +
                            'answering instead of the application. Original error: ' + error.message,
                        ));
                        return;
                    }

                    try {
                        resolve({ spec: assertUsableSpec(parsed, String(url)), specPath: String(url) });
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );

        request.on('timeout', () => {
            request.destroy(new Error(`${url} did not answer within ${config.timeoutMs} ms.`));
        });

        request.on('error', (error) => {
            reject(new Error(
                `Cannot reach ${url}: ${error.message}. ` +
                (url.protocol === 'https:' && !config.allowInsecureTls
                    ? 'If this is a development stand with a self-signed certificate, ' +
                      'set WARDENPOINT_ALLOW_INSECURE_TLS=1 — never against production.'
                    : 'Check that the installation is up and reachable from here.'),
            ));
        });
    });
}

/**
 * The explicit path wins; otherwise the installation describes itself.
 */
export async function resolveSpec(config) {
    if (config.specPath) {
        return loadSpecFromFile(config.specPath);
    }

    const failures = [];

    for (const endpoint of SPEC_ENDPOINTS) {
        try {
            return await fetchSpecFrom(config, endpoint);
        } catch (error) {
            failures.push(`  ${config.baseUrl}${endpoint} — ${error.message}`);
        }
    }

    throw new Error(
        'Could not read the OpenAPI description from the installation. Tried:\n' +
        failures.join('\n'),
    );
}

function assertUsableSpec(spec, source) {
    if (!spec || typeof spec !== 'object' || !spec.paths || typeof spec.paths !== 'object') {
        throw new Error(`The OpenAPI description from ${source} has no "paths" object.`);
    }

    return spec;
}

/**
 * Inline every $ref into a self-contained JSON Schema.
 *
 * MCP clients hand the tool schema straight to a model; a $ref the client does
 * not resolve is a field the model never sees. The component graph in this
 * project is acyclic (checked below), so full inlining is safe; a cycle is
 * reported rather than silently truncated.
 */
export function dereference(node, spec, trail = []) {
    if (node === null || typeof node !== 'object') {
        return node;
    }

    if (Array.isArray(node)) {
        return node.map((item) => dereference(item, spec, trail));
    }

    if (typeof node.$ref === 'string') {
        const name = node.$ref.replace('#/components/schemas/', '');

        if (trail.includes(name)) {
            throw new Error(`Cyclic $ref in the OpenAPI description: ${[...trail, name].join(' -> ')}`);
        }

        const target = spec.components?.schemas?.[name];

        if (!target) {
            throw new Error(`Dangling $ref in the OpenAPI description: ${node.$ref}`);
        }

        const resolved = dereference(target, spec, [...trail, name]);
        const siblings = { ...node };
        delete siblings.$ref;

        // A $ref with siblings (description, example) is legal in OpenAPI 3.1
        // and common in the wild; the siblings win, the way readers expect.
        return Object.keys(siblings).length > 0
            ? { ...resolved, ...dereference(siblings, spec, trail) }
            : resolved;
    }

    const out = {};
    for (const [key, value] of Object.entries(node)) {
        out[key] = dereference(value, spec, trail);
    }
    return out;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** Flat list of { path, method, operation } in description order. */
export function listOperations(spec) {
    const operations = [];

    for (const [path, item] of Object.entries(spec.paths)) {
        for (const method of HTTP_METHODS) {
            if (item[method]) {
                operations.push({ path, method, operation: item[method] });
            }
        }
    }

    return operations;
}
