import { revalidatePath } from 'next/cache';
import {
    handleWebhook,
    type AppConfig,
    type GitConfig,
    type EvictionConfig,
} from '@seanstoves/ss-gitops-jsondb';

/*
 * Next adapter — EXAMPLE, copy it into your app and adjust. The only place a next/cache
 * import lives: the core lib hands back paths, this turns them into revalidatePath
 * calls. revalidatePath blows up during render — call it from a Route Handler or
 * Server Action only.
 *
 * The config below reads from env here so the example actually runs, but the core lib
 * takes config as params — nothing forces you onto these env names.
 */

// fallback evict set when there's no before/after diff to work from (first push, force
// push). swap these for your own routes — it's just an example surface.
const DEFAULT_PATHS = ['/', '/blog', '/projects', '/resume'];

/* map the lib's evict-path list onto Next's cache. a path with [param] in it is a route
 * group ('page' kind), everything else is a literal path. */
export function evict(paths: string[]) {
    for (const p of paths) {
        if (p.includes('[') && p.includes(']')) revalidatePath(p, 'page');
        else revalidatePath(p);
    }
}

function envApp(): AppConfig {
    return {
        appId: need('GH_APP_ID'),
        installationId: need('GH_APP_INSTALLATION_ID'),
        privateKeyPem: Buffer.from(need('GH_APP_PRIVATE_KEY'), 'base64').toString(),
        apiBaseUrl: process.env.GH_API_BASE_URL,
    };
}

function envGit(): GitConfig {
    return {
        contentDir: need('CONTENT_DIR'),
        remoteUrl: process.env.CONTENT_REMOTE,
    };
}

/* example matrix: a changed blog post busts its detail page + /blog + /; the singleton
 * json files bust their own pages. edit to match your content shape. */
const eviction: EvictionConfig = {
    patterns: [
        {
            pattern: /^blog\/(.+)\.md$/,
            evict: (slug) => [`/blog/${slug}`],
            also: ['/blog', '/'],
        },
    ],
    static: [
        { file: 'resume/resume.json', evict: ['/resume'] },
        { file: 'projects.json', evict: ['/projects'] },
        { file: 'home.json', evict: ['/'] },
    ],
};

function need(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} not set`);
    return v;
}

/*
 * Drop this in app/api/webhook/git-sync/route.ts (or wherever) and export POST. Reads
 * the RAW request bytes for the signature check, runs the core orchestrator, then
 * evicts whatever paths it hands back.
 */
export async function POST(req: Request) {
    const secret = process.env.GH_WEBHOOK_SECRET;
    if (!secret) return new Response('webhook not configured', { status: 503 });

    const raw = Buffer.from(await req.arrayBuffer());

    const result = await handleWebhook({
        rawBody: raw,
        signatureHeader: req.headers.get('x-hub-signature-256'),
        eventHeader: req.headers.get('x-github-event'),
        secret,
        app: envApp(),
        git: envGit(),
        eviction,
        ref: 'refs/heads/main',
        fallbackPaths: DEFAULT_PATHS,
    });

    if (!result.ok) return new Response(result.reason, { status: result.status });

    if (result.fullEvict) {
        evict(DEFAULT_PATHS);
        revalidatePath('/blog/[slug]', 'page');
    } else {
        evict(result.evictPaths);
    }

    return Response.json({ ok: true, files: result.changedFiles, evicted: result.evictPaths });
}
