#!/usr/bin/env node
/**
 * The one failure this package must never ship again.
 *
 * Before the first release the server resolved its OpenAPI description through
 * a path inside the WardenPoint monorepo. Everything worked in development and
 * nothing would have worked for anybody who installed it: the file simply is
 * not there. Unit tests could not have caught it — the bug only exists once the
 * code is packed, installed elsewhere and started with no repository in sight.
 *
 * So that is what this does. It packs the package, installs the tarball into an
 * empty directory, runs the installed binary from there and checks that it
 * fails for the RIGHT reason — because it could not reach the installation,
 * not because a file was missing.
 *
 * No live WardenPoint needed: an unreachable address proves the point better
 * than a reachable one.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = mkdtempSync(join(tmpdir(), 'wardenpoint-mcp-pack-'));

function run(command, args, options = {}) {
    return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function fail(message) {
    process.stderr.write(`FAIL: ${message}\n`);
    rmSync(workspace, { recursive: true, force: true });
    process.exit(1);
}

try {
    run('npm', ['pack', '--pack-destination', workspace], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });

    const tarball = readdirSync(workspace).find((name) => name.endsWith('.tgz'));
    if (!tarball) {
        fail('npm pack produced no tarball.');
    }

    run('npm', ['init', '-y'], { cwd: workspace, stdio: 'ignore' });
    run('npm', ['install', join(workspace, tarball)], { cwd: workspace, stdio: ['ignore', 'ignore', 'inherit'] });

    // Port 9 is the discard service: reliably refuses, everywhere, instantly.
    let output = '';
    let exitCode = 0;

    try {
        output = run(join(workspace, 'node_modules', '.bin', 'wardenpoint-mcp-server'), ['--list-tools'], {
            cwd: workspace,
            env: {
                ...process.env,
                WARDENPOINT_BASE_URL: 'http://127.0.0.1:9',
                WARDENPOINT_TIMEOUT_MS: '3000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        exitCode = error.status ?? 1;
        output = `${error.stdout || ''}${error.stderr || ''}`;
    }

    if (exitCode === 0) {
        fail('The binary succeeded against an unreachable installation. It should refuse.');
    }

    if (/Cannot read the OpenAPI description|ENOENT|no such file/i.test(output)) {
        fail(
            'The installed package still looks for the description on disk. ' +
            'That is the monorepo-path bug returning:\n' + output,
        );
    }

    // Both published paths must be attempted and named. Version 0.1.0 knew
    // only `/docs`, which l5-swagger serves — and l5-swagger is a dev
    // dependency of the application, so that path does not exist in
    // production. The package was unusable against a real installation and
    // nothing here would have noticed.
    for (const endpoint of ['/api/openapi.json', '/docs']) {
        if (!output.includes(`http://127.0.0.1:9${endpoint}`)) {
            fail(`Expected the failure to name ${endpoint}, got:\n` + output);
        }
    }

    process.stdout.write('ok — packed, installed elsewhere, and failed for the right reason\n');
} finally {
    rmSync(workspace, { recursive: true, force: true });
}
