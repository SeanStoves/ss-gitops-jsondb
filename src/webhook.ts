import { verifyGithubSig } from './webhook-sig.ts';
import { changedFiles, pull, type GitConfig } from './git.ts';
import { installationToken, type AppConfig } from './github.ts';
import { evictForFiles, type EvictionConfig } from './eviction.ts';

/*
 * The inbound half of the GitOps loop, framework-free. Hand it the raw webhook bytes
 * and the config and it runs:
 *   verify sig -> push event on the watched branch? -> mint token -> pull -> diff the
 *   before/after SHAs locally -> map the changed files to evict paths.
 *
 * Returns the changed files and the paths to evict. It does NOT touch any cache itself —
 * the adapter does that with what comes back. Nothing in here imports Next or Express.
 *
 * Changed files come from diffing the SHAs after the pull, not from the webhook payload's
 * own file list — that list is attacker-influenced and GitHub truncates it anyway, so it
 * can't be trusted to be complete.
 */

export type WebhookResult =
    | { ok: false; status: number; reason: string }
    | { ok: true; event: string; ignored?: string; changedFiles: string[]; evictPaths: string[]; fullEvict: boolean };

export type WebhookOptions = {
    rawBody: string | Buffer;
    signatureHeader: string | null;
    eventHeader?: string | null;
    secret: string;
    app: AppConfig;
    git: GitConfig;
    eviction: EvictionConfig;
    /* full ref to act on, defaults to refs/heads/main. anything else is ignored (ok:true) */
    ref?: string;
    /* what to evict when the changed-file diff can't be computed (first push / force push) */
    fallbackPaths?: string[];
};

export async function handleWebhook(opts: WebhookOptions): Promise<WebhookResult> {
    if (!opts.secret) return { ok: false, status: 503, reason: 'webhook not configured' };

    // hmac the RAW bytes — reparsing the JSON would shift them and the signature wouldn't match
    if (!(await verifyGithubSig(opts.secret, opts.rawBody, opts.signatureHeader))) {
        return { ok: false, status: 401, reason: 'bad signature' };
    }

    const event = opts.eventHeader ?? '';
    if (event === 'ping') return { ok: true, event, changedFiles: [], evictPaths: [], fullEvict: false };
    if (event !== 'push') return { ok: true, event, ignored: event, changedFiles: [], evictPaths: [], fullEvict: false };

    const raw = Buffer.isBuffer(opts.rawBody) ? opts.rawBody.toString() : opts.rawBody;
    let payload: { ref?: string; before?: string; after?: string };
    try {
        payload = JSON.parse(raw);
    } catch {
        return { ok: false, status: 400, reason: 'bad payload' };
    }

    const watchRef = opts.ref || 'refs/heads/main';
    if (payload.ref !== watchRef) {
        return { ok: true, event, ignored: payload.ref ?? '(no ref)', changedFiles: [], evictPaths: [], fullEvict: false };
    }

    const token = await installationToken(opts.app);
    await pull(opts.git, token);

    let files: string[] = [];
    try {
        if (payload.before && payload.after) files = await changedFiles(opts.git, payload.before, payload.after);
    } catch {
        // before sha isn't in the local history (first push / force push) — no diff to take, fall back
    }

    if (files.length > 0) {
        return { ok: true, event, changedFiles: files, evictPaths: evictForFiles(files, opts.eviction), fullEvict: false };
    }
    return { ok: true, event, changedFiles: [], evictPaths: opts.fallbackPaths ?? [], fullEvict: true };
}
