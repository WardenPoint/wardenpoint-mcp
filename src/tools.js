import { dereference, listOperations } from './spec.js';

/**
 * Operations deliberately kept away from the agent, by path.
 *
 * Nothing is dropped silently: anything excluded is named here with a reason
 * and counted in the startup report, so a future reader can tell an omission
 * from an oversight. The public status feeds live in `routes/web.php` and are
 * not described in the OpenAPI file at all today; they are listed anyway so
 * that describing them later does not quietly hand them to an agent that has
 * no use for a public status page.
 */
export const EXCLUDED_PATHS = new Map([
    ['/api/status/summary.json', 'public status feed — public marketing surface, nothing to configure'],
    ['/api/status/components.json', 'public status feed — public marketing surface, nothing to configure'],
    ['/api/status/incidents.json', 'public status feed — public marketing surface, nothing to configure'],
    ['/status/summary.json', 'public status feed — public marketing surface, nothing to configure'],
    ['/status/components.json', 'public status feed — public marketing surface, nothing to configure'],
    ['/status/incidents.json', 'public status feed — public marketing surface, nothing to configure'],
]);

/** The property a tool grows when its operation authenticates with an integration secret. */
export const INTEGRATION_SECRET_PROPERTY = 'integration_secret';

const INTEGRATION_SECRET_DESCRIPTION =
    'The plain secret of THIS observability integration — not an API key. It is returned exactly once, ' +
    'by the response of `v1_observability_integrations_store`, and afterwards only by a rotation in the ' +
    'dashboard; WardenPoint cannot show it to you again. Sent as `Authorization: Bearer <secret>`.';

const AUTO_GENERATED_ID = /^[0-9a-f]{32}$/;
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

const METHOD_SUFFIX = {
    get: 'index',
    post: 'store',
    put: 'update',
    patch: 'patch',
    delete: 'destroy',
};

/** A readable stand-in for an operation the description failed to name. */
function deriveName(method, path) {
    const segments = path.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
    const literals = segments.filter((segment) => !segment.startsWith('{'));

    if (literals.length === 0) {
        return `v1_${method}`;
    }

    const last = segments[segments.length - 1];
    const hasPathParam = segments.some((segment) => segment.startsWith('{'));

    // A trailing literal after a first segment is an action and names itself
    // (`/notifications/send`, `/recipients/{id}/routes`). A bare collection or
    // a path ending in an identifier needs the verb spelling out.
    const namesItself = !last.startsWith('{') && segments.length > 1;

    const parts = namesItself
        ? literals
        : [...literals, method === 'get' && hasPathParam ? 'show' : METHOD_SUFFIX[method]];

    return `v1_${parts.join('_')}`.replace(/-/g, '_');
}

function securitySchemes(operation) {
    return (operation.security || []).flatMap((requirement) => Object.keys(requirement));
}

/**
 * The text the agent reads. The summary and description come from the
 * description file untouched — they are the whole product of the phases that
 * preceded this server. The appended block carries only what the file states
 * structurally rather than in prose: the route, and every response the
 * operation can answer with. Error wording is what an agent repairs itself
 * from, so it is put in front of the model before the call, not only after it.
 */
function buildDescription({ path, method, operation, schemes }) {
    const blocks = [];

    if (operation.summary) {
        blocks.push(operation.summary.trim());
    }

    if (operation.description) {
        blocks.push(operation.description.trim());
    }

    blocks.push(`HTTP: ${method.toUpperCase()} ${path}`);

    if (schemes.includes('integrationSecret')) {
        blocks.push(
            `Authentication: integration secret, passed as the \`${INTEGRATION_SECRET_PROPERTY}\` argument of this tool. ` +
            'The company API key is neither used nor accepted here.',
        );
    } else if (schemes.includes('apiKey')) {
        blocks.push('Authentication: the company API key configured on this MCP server.');
    } else {
        blocks.push('Authentication: none — this operation is declared public in the API description.');
    }

    const responses = Object.entries(operation.responses || {})
        .map(([code, response]) => `- ${code}: ${(response.description || '(no description)').trim()}`)
        .join('\n');

    if (responses) {
        blocks.push(`Responses:\n${responses}`);
    }

    return blocks.join('\n\n');
}

function parameterSchema(parameter, spec) {
    const schema = dereference(parameter.schema || { type: 'string' }, spec);

    // The parameter's own description outranks the schema's: it is the one
    // written for the caller.
    return parameter.description
        ? { ...schema, description: parameter.description }
        : schema;
}

function buildTool({ path, method, operation }, spec, findings) {
    const schemes = securitySchemes(operation);
    const parameters = (operation.parameters || []).filter((parameter) => parameter.in === 'path' || parameter.in === 'query');

    const properties = {};
    const required = [];

    for (const parameter of parameters) {
        properties[parameter.name] = parameterSchema(parameter, spec);

        if (parameter.required || parameter.in === 'path') {
            required.push(parameter.name);
        }
    }

    const bodyMedia = operation.requestBody?.content?.['application/json'];

    if (operation.requestBody && !bodyMedia) {
        findings.push({
            kind: 'request-body-without-json',
            operation: operation.operationId || `${method.toUpperCase()} ${path}`,
            detail: `content types: ${Object.keys(operation.requestBody.content || {}).join(', ') || 'none'}`,
        });
    }

    if (bodyMedia) {
        if (!bodyMedia.schema) {
            findings.push({
                kind: 'request-body-without-schema',
                operation: operation.operationId || `${method.toUpperCase()} ${path}`,
                detail: 'application/json body has no schema; the agent gets an untyped object',
            });
        }

        const bodySchema = bodyMedia.schema
            ? dereference(bodyMedia.schema, spec)
            : { type: 'object', description: 'Free-form JSON body — the description declares no schema for it.' };

        // The body stays a document of its own rather than being merged into
        // the argument list: some bodies (webhook payloads) accept arbitrary
        // keys, and flattening those would let a payload key shadow a path
        // parameter with no way to tell which the caller meant.
        properties.body = {
            ...bodySchema,
            description: bodySchema.description
                || bodySchema.title
                || operation.requestBody.description
                || 'JSON request body.',
        };

        if (operation.requestBody.required) {
            required.push('body');
        }
    }

    if (schemes.includes('integrationSecret')) {
        if (properties[INTEGRATION_SECRET_PROPERTY]) {
            throw new Error(
                `Operation ${operation.operationId} already declares a "${INTEGRATION_SECRET_PROPERTY}" ` +
                'parameter; the integration-secret argument would shadow it.',
            );
        }

        properties[INTEGRATION_SECRET_PROPERTY] = {
            type: 'string',
            description: INTEGRATION_SECRET_DESCRIPTION,
        };
        required.push(INTEGRATION_SECRET_PROPERTY);
    }

    return {
        path,
        method,
        schemes,
        parameters,
        hasBody: Boolean(bodyMedia),
        definition: {
            name: null, // assigned by buildTools once uniqueness is settled
            description: buildDescription({ path, method, operation, schemes }),
            inputSchema: {
                type: 'object',
                properties,
                ...(required.length > 0 ? { required } : {}),
            },
        },
    };
}

/** Every gap that stopped an operation from becoming a tool on its own terms. */
function auditOperation({ path, method, operation }, spec, findings) {
    const label = operation.operationId || `${method.toUpperCase()} ${path}`;

    if (!operation.operationId) {
        findings.push({ kind: 'missing-operation-id', operation: `${method.toUpperCase()} ${path}`, detail: 'no operationId at all' });
    } else if (AUTO_GENERATED_ID.test(operation.operationId)) {
        findings.push({
            kind: 'generated-operation-id',
            operation: `${method.toUpperCase()} ${path}`,
            detail: `operationId is the generator's md5 hash "${operation.operationId}", not a name`,
        });
    } else if (!operation.operationId.startsWith('v1_')) {
        findings.push({
            kind: 'off-convention-operation-id',
            operation: label,
            detail: 'operationId does not follow the v1_<plural>_<action> convention',
        });
    }

    if (!operation.summary) {
        findings.push({ kind: 'missing-summary', operation: label, detail: 'tool has no one-line purpose' });
    }

    if (!operation.description) {
        findings.push({ kind: 'missing-description', operation: label, detail: 'tool description falls back to the summary alone' });
    }

    if (!operation.tags || operation.tags.length !== 1) {
        findings.push({
            kind: 'tag-count',
            operation: label,
            detail: `expected exactly one tag, found ${operation.tags ? operation.tags.length : 0}`,
        });
    }

    const declared = new Set((operation.parameters || []).filter((p) => p.in === 'path').map((p) => p.name));
    for (const placeholder of path.matchAll(/\{([^}]+)\}/g)) {
        if (!declared.has(placeholder[1])) {
            findings.push({
                kind: 'undeclared-path-placeholder',
                operation: label,
                detail: `the route contains {${placeholder[1]}} but no path parameter declares it; the call cannot be built`,
            });
        }
    }

    for (const parameter of operation.parameters || []) {
        if (!parameter.description) {
            findings.push({
                kind: 'parameter-without-description',
                operation: label,
                detail: `${parameter.in} parameter "${parameter.name}" is a bare name to the agent`,
            });
        }

        if (!parameter.schema) {
            findings.push({
                kind: 'parameter-without-schema',
                operation: label,
                detail: `${parameter.in} parameter "${parameter.name}" has no type; assumed string`,
            });
        }

        if (parameter.in !== 'path' && parameter.in !== 'query') {
            findings.push({
                kind: 'unsupported-parameter-location',
                operation: label,
                detail: `parameter "${parameter.name}" is in:${parameter.in}, which this server does not map`,
            });
        }
    }

    const bodySchema = operation.requestBody?.content?.['application/json']?.schema;

    if (bodySchema) {
        // Only the top level is walked: a nested object arrives with its parent
        // property's description, and drilling deeper turns one missing word
        // into a page of noise.
        const inlined = (() => {
            try {
                return dereference(bodySchema, spec);
            } catch {
                return null;
            }
        })();

        for (const [name, property] of Object.entries(inlined?.properties || {})) {
            if (!property.description && !property.title) {
                findings.push({
                    kind: 'body-field-without-description',
                    operation: label,
                    detail: `request-body field "${name}" is a bare name to the agent`,
                });
            }
        }
    }

    if (!operation.responses || Object.keys(operation.responses).length === 0) {
        findings.push({ kind: 'no-responses', operation: label, detail: 'the agent is told nothing about what comes back' });
    }

    for (const [code, response] of Object.entries(operation.responses || {})) {
        if (!response.description) {
            findings.push({ kind: 'response-without-description', operation: label, detail: `response ${code} has no description` });
        }
    }

    for (const requirement of operation.security || []) {
        for (const scheme of Object.keys(requirement)) {
            if (!['apiKey', 'integrationSecret'].includes(scheme)) {
                findings.push({
                    kind: 'unknown-security-scheme',
                    operation: label,
                    detail: `security scheme "${scheme}" has no handler in this server`,
                });
            }
        }
    }
}

/**
 * Build the whole tool set from the description. One operation, one tool.
 */
export function buildTools(spec) {
    const findings = [];
    const excluded = [];
    const tools = [];
    const taken = new Map();

    for (const entry of listOperations(spec)) {
        if (EXCLUDED_PATHS.has(entry.path)) {
            excluded.push({ path: entry.path, method: entry.method, reason: EXCLUDED_PATHS.get(entry.path) });
            continue;
        }

        auditOperation(entry, spec, findings);

        const tool = buildTool(entry, spec, findings);
        const usable = entry.operation.operationId
            && !AUTO_GENERATED_ID.test(entry.operation.operationId)
            && VALID_TOOL_NAME.test(entry.operation.operationId);

        let name = usable ? entry.operation.operationId : deriveName(entry.method, entry.path);

        if (!usable) {
            findings.push({
                kind: 'name-derived-from-route',
                operation: `${entry.method.toUpperCase()} ${entry.path}`,
                detail: `no usable operationId; the tool is named "${name}" after its route instead`,
            });
        }

        if (taken.has(name)) {
            const clash = name;
            let suffix = 2;
            while (taken.has(`${clash}_${suffix}`)) {
                suffix += 1;
            }
            name = `${clash}_${suffix}`;

            findings.push({
                kind: 'duplicate-tool-name',
                operation: `${entry.method.toUpperCase()} ${entry.path}`,
                detail: `name "${clash}" is already taken by ${taken.get(clash)}; this tool became "${name}"`,
            });
        }

        taken.set(name, `${entry.method.toUpperCase()} ${entry.path}`);
        tool.definition.name = name;
        tools.push(tool);
    }

    return { tools, findings, excluded };
}
