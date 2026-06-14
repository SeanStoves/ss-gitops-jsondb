import { createPrivateKey } from 'node:crypto';

/*
 * GitHub App installation token, signed with crypto.subtle RS256 — no jsonwebtoken,
 * no octokit. The PEM stays in-process and the imported key is non-extractable, so
 * nothing can read the signing material back out once it's loaded.
 *
 * Every call carries its own config, so one process can mint for several apps or hit
 * a self-hosted GHE instead of the public api. apiBaseUrl defaults to api.github.com.
 */

export type AppConfig = {
    appId: string | number;
    installationId: string | number;
    /* the App's private key as PEM text. GitHub hands out a PKCS#1 PEM ("RSA PRIVATE
     * KEY"); webcrypto only takes PKCS#8, so node converts it below. Pass the decoded
     * PEM — if you stash it base64'd in an env var, decode it before you get here. */
    privateKeyPem: string;
    apiBaseUrl?: string;
};

type CacheEntry = { token: string; exp: number };

// keyed per host+app+installation so a multi-app caller never hands one app's token to another
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function cacheKey(cfg: AppConfig, base: string) {
    // JSON-encode the parts so a crafted id containing the separator can't collide two
    // different apps onto one cache slot and serve the wrong installation's token
    return JSON.stringify([base, String(cfg.appId), String(cfg.installationId)]);
}

async function appJwt(cfg: AppConfig) {
    // github gives pkcs#1, webcrypto wants pkcs#8 — let node do the conversion
    const der = createPrivateKey(cfg.privateKeyPem).export({ type: 'pkcs8', format: 'der' });
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);

    const now = Math.floor(Date.now() / 1000);
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(cfg.appId) }));
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${head}.${body}`));
    return `${head}.${body}.${b64u(Buffer.from(sig))}`;
}

/* hour-lived installation token, cached in memory, re-minted 5 min before it dies —
 * regenerates before it dies, very Time Lord. concurrent misses coalesce onto the one
 * in-flight fetch so a burst of callers doesn't mint a pile of duplicate tokens. */
export async function installationToken(cfg: AppConfig): Promise<string> {
    const base = (cfg.apiBaseUrl || 'https://api.github.com').replace(/\/+$/, '');
    const ck = cacheKey(cfg, base);

    const hit = cache.get(ck);
    if (hit && Date.now() < hit.exp - 300_000) return hit.token;

    const pending = inflight.get(ck);
    if (pending) return pending;

    const job = (async () => {
        try {
            const res = await fetch(`${base}/app/installations/${cfg.installationId}/access_tokens`, {
                method: 'POST',
                headers: { authorization: `Bearer ${await appJwt(cfg)}`, accept: 'application/vnd.github+json' },
            });
            if (res.status !== 201) throw new Error(`installation token: HTTP ${res.status}`);
            const data = await res.json() as { token?: unknown; expires_at?: unknown };
            const exp = Date.parse(String(data.expires_at));
            if (typeof data.token !== 'string' || !data.token || Number.isNaN(exp)) throw new Error('malformed token response');
            cache.set(ck, { token: data.token, exp });
            return data.token;
        } finally {
            inflight.delete(ck);
        }
    })();
    inflight.set(ck, job);
    return job;
}
