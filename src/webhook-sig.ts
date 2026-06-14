/*
 * GitHub webhook signature check, crypto.subtle only — no hmac dep.
 *
 * X-Hub-Signature-256 is 'sha256=' + the hex hmac of the raw body. subtle.verify
 * compares in constant time — hand-rolling a hex string compare leaks timing, so don't.
 *
 * Caller hands me the raw request bytes (Buffer.from(await req.arrayBuffer())), not
 * JSON that got parsed and restringified — re-serializing reorders keys and whitespace
 * and the hmac stops matching. Verify first, parse second.
 */
export async function verifyGithubSig(secret: string, rawBody: string | Buffer, header: string | null): Promise<boolean> {
    // typeof check, not just !header: a framework can hand back an array of header values.
    // anything that isn't a clean 'sha256=' string fails closed as false, never a 500.
    if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
    const hex = header.slice(7);
    if (!/^[0-9a-f]{64}$/.test(hex)) return false;
    const key = await crypto.subtle.importKey('raw', Buffer.from(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('HMAC', key, Buffer.from(hex, 'hex'), Buffer.from(rawBody));
}
