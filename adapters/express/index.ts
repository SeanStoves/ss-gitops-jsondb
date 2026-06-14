import {
    handleWebhook,
    type AppConfig,
    type GitConfig,
    type EvictionConfig,
} from 'ss-gitops-jsondb';

/*
 * Express adapter — EXAMPLE. Express gives you no raw body by default and JSON
 * middleware reparses it, which breaks the HMAC. Mount the RAW body parser on this
 * route ONLY so req.body is the exact bytes GitHub signed:
 *
 *   import express from 'express';
 *   import { githubWebhook } from 'ss-gitops-jsondb/adapters/express';
 *
 *   const app = express();
 *   app.post(
 *       '/webhook/git-sync',
 *       express.raw({ type: '*\/*' }),   // raw bytes, no JSON reparse
 *       githubWebhook({ app: ..., git: ..., eviction: ..., secret: ..., onEvict }),
 *   );
 *
 * onEvict gets the path list the core computed — wire it to your CDN purge, in-memory
 * cache bust, or whatever serves your pages. The lib stays framework-free; this glue is
 * yours to own.
 */

type Req = { headers: Record<string, string | string[] | undefined>; body: unknown };
type Res = {
    status(code: number): Res;
    send(body: string): void;
    json(body: unknown): void;
};

export type ExpressWebhookConfig = {
    secret: string;
    app: AppConfig;
    git: GitConfig;
    eviction: EvictionConfig;
    ref?: string;
    fallbackPaths?: string[];
    /* called with the paths to evict on a successful push. if it's async, we await it. */
    onEvict: (paths: string[], meta: { changedFiles: string[]; fullEvict: boolean }) => void | Promise<void>;
};

function header(req: Req, name: string): string | null {
    const v = req.headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0] ?? null;
    return v ?? null;
}

export function githubWebhook(cfg: ExpressWebhookConfig) {
    return async (req: Req, res: Res) => {
        // express.raw hands us a Buffer; bail loud if some other parser got there first
        const raw = Buffer.isBuffer(req.body) ? req.body : null;
        if (!raw) {
            res.status(500).send('raw body required — mount express.raw on this route');
            return;
        }

        const result = await handleWebhook({
            rawBody: raw,
            signatureHeader: header(req, 'x-hub-signature-256'),
            eventHeader: header(req, 'x-github-event'),
            secret: cfg.secret,
            app: cfg.app,
            git: cfg.git,
            eviction: cfg.eviction,
            ref: cfg.ref,
            fallbackPaths: cfg.fallbackPaths,
        });

        if (!result.ok) {
            res.status(result.status).send(result.reason);
            return;
        }

        const toEvict = result.fullEvict ? (cfg.fallbackPaths ?? []) : result.evictPaths;
        if (result.event === 'push') {
            await cfg.onEvict(toEvict, { changedFiles: result.changedFiles, fullEvict: result.fullEvict });
        }

        res.json({ ok: true, files: result.changedFiles, evicted: toEvict });
    };
}
