import { spawn } from 'node:child_process';
import path from 'node:path';

/*
 * Thin git wrapper. Two things here are non-negotiable:
 *   1. argv spawn only, no shell — a slug or commit message can't break out into a
 *      command no matter what's in it.
 *   2. the auth token goes into git through GIT_CONFIG env (http.extraheader), never
 *      argv. /proc/<pid>/cmdline is world-readable and the Authorization header has
 *      no business sitting there for any local user to scrape.
 *
 * Content dir, remote host, and branch are all params — nothing's hardcoded to
 * /content / github.com / main anymore.
 */

const SHA_RE = /^[0-9a-f]{7,40}$/;
const EMAIL_RE = /^[^<>\s@]+@[^<>\s@]+$/;

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitConfig = {
    /* absolute path to the content checkout. every spawn's cwd is locked here */
    contentDir: string;
    /* remote base url that gets the auth header attached, e.g. https://github.com/
     * or https://ghe.example.com/. trailing slash optional, normalized below */
    remoteUrl?: string;
    branch?: string;
    remote?: string;
    timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 60_000;
const MAX_OUTPUT = 16 * 1024 * 1024; // 16MB ceiling on buffered git stdout/stderr

function root(cfg: GitConfig) {
    return path.resolve(cfg.contentDir);
}

/*
 * Config goes in through env, never argv — same /proc/<pid>/cmdline reason as the
 * token. Picks up wherever GIT_CONFIG_COUNT already left off so anything the
 * environment baked in (safe.directory etc) survives instead of getting clobbered.
 */
function configEnv(pairs: [string, string][]) {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    let n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    for (const [k, v] of pairs) {
        env[`GIT_CONFIG_KEY_${n}`] = k;
        env[`GIT_CONFIG_VALUE_${n}`] = v;
        n++;
    }
    env.GIT_CONFIG_COUNT = String(n);
    return env;
}

/* argv spawn, cwd locked to the content volume. no shell, ever */
export function run(cfg: GitConfig, args: string[], gitcfg: [string, string][] = []): Promise<GitResult> {
    const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd: root(cfg), env: configEnv(gitcfg), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`git ${args[0]} timed out`)); }, timeout);
        // a push-access attacker controls the diff size; cap what we buffer so an absurd
        // number of files (or huge paths) can't inflate memory before the timeout fires
        const collect = (cur: string, d: Buffer, label: string): string => {
            const next = cur + d;
            if (next.length > MAX_OUTPUT) { clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(`git ${args[0]} ${label} output too large`)); return cur; }
            return next;
        };
        child.stdout.on('data', (d) => { stdout = collect(stdout, d, 'stdout'); });
        child.stderr.on('data', (d) => { stderr = collect(stderr, d, 'stderr'); });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
}

function ok(res: GitResult, what: string) {
    // stderr can carry attacker-controlled text — a crafted commit message or author
    // name surfacing inside a merge or auth error. this string ends up in a client-facing
    // message, so collapse whitespace to one line and cap it. bounded, single line, no raw dump.
    if (res.code !== 0) throw new Error(`git ${what} failed (${res.code}): ${res.stderr.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
    return res.stdout;
}

/* http.<base>.extraheader carries the token as an HTTP Basic header. scoped to the
 * specific remote base, so git won't leak it to any other host it ends up talking to */
function authCfg(cfg: GitConfig, token: string): [string, string][] {
    const base = (cfg.remoteUrl || 'https://github.com/').replace(/\/?$/, '/');
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    return [[`http.${base}.extraheader`, `Authorization: Basic ${basic}`]];
}

export async function status(cfg: GitConfig) {
    return ok(await run(cfg, ['status', '--porcelain']), 'status');
}

export async function headSha(cfg: GitConfig) {
    return ok(await run(cfg, ['rev-parse', 'HEAD']), 'rev-parse').trim();
}

export async function addAll(cfg: GitConfig) {
    ok(await run(cfg, ['add', '--all', '--']), 'add');
}

/*
 * --author is a single argv element so there's no flag injection here, but name and
 * email come off an external profile — a malformed one makes git abort the whole commit
 * (exit 128). Strip control chars / angle brackets off the name, validate the email, and
 * if either's junk, fall back to the configured GIT_CONFIG identity rather than blow up the save.
 */
export async function commit(cfg: GitConfig, message: string, author?: { name: string; email: string }) {
    const args = ['commit', '-m', message];
    if (author) {
        const name = author.name.replace(/[\x00-\x1f<>]/g, '').trim();
        if (name && EMAIL_RE.test(author.email)) args.push(`--author=${name} <${author.email}>`);
    }
    ok(await run(cfg, args), 'commit');
}

export async function pull(cfg: GitConfig, token: string) {
    const remote = cfg.remote || 'origin';
    const branch = cfg.branch || 'main';
    ok(await run(cfg, ['pull', '--ff-only', remote, branch], authCfg(cfg, token)), 'pull');
}

export async function push(cfg: GitConfig, token: string) {
    const remote = cfg.remote || 'origin';
    const branch = cfg.branch || 'main';
    ok(await run(cfg, ['push', remote, branch], authCfg(cfg, token)), 'push');
}

/* feeds cache eviction, so the inputs get the full paranoid treatment. a sha that
 * isn't actually a sha could smuggle in an option flag, so both get range-checked first.
 * -z gives NUL-delimited raw paths so a filename with a newline in it can't split into
 * two entries; trailing -- stops the range being read as a pathspec. --no-renames forces
 * a rename to show up as delete(old)+add(new) so eviction busts BOTH paths — without it
 * git collapses the rename to the new name and the old page serves stale forever */
export async function changedFiles(cfg: GitConfig, before: string, after: string) {
    if (!SHA_RE.test(before) || !SHA_RE.test(after)) throw new Error('bad sha');
    const out = ok(await run(cfg, ['diff', '--name-only', '--no-renames', '-z', `${before}..${after}`, '--']), 'diff');
    return out.split('\0').filter(Boolean);
}
