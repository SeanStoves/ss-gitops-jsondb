import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

/*
 * Path-safety helpers for reading files out of a content repo that anyone with push
 * access can write to — the on-disk tree is a hostile boundary, treat it like one.
 * Two layers:
 *
 *   1. safePath() — lexical. Each segment (minus a trailing .md/.json) must be a
 *      clean slug, and the joined path must re-anchor inside the root. Stops ../,
 *      encoded junk, empty/absolute segments. Does NOT stop symlinks.
 *   2. readInRoot()/openInRoot() — runtime. realpath the parent, assert it's in the
 *      root, then open the leaf O_NOFOLLOW so a symlinked leaf comes back ELOOP. The
 *      fd binds the inode at open time: no check-then-use-by-path race.
 *
 * Pass the content root explicitly — nothing in here reads process.env.
 */

// no '.' in here, ever — safePath strips one trailing .md/.json before testing, so a
// dot in the class would let '..json' collapse to a traversal segment
export const SLUG_RE = /^[a-zA-Z0-9-_]+$/;

const EXT_RE = /\.(md|json)$/;

/*
 * Lexical first pass. Each segment (extension stripped) has to be a clean slug, and
 * the joined result has to re-anchor inside the root. Throws; callers treat that as a
 * 404. This alone does NOT stop symlinks or a slug that looks like a CLI flag — go
 * through openInRoot for disk access and never hand a raw slug to git.
 */
export function safePath(root: string, ...parts: string[]) {
    const base = path.resolve(root);
    for (const part of parts)
        if (!SLUG_RE.test(part.replace(EXT_RE, ''))) throw new Error('rejected path segment');
    const resolved = path.resolve(base, ...parts);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('path escaped content root');
    return resolved;
}

/* lexical assert: `p` resolves to `root` itself or something under it. cheap guard
 * for callers that built a path some other way and just want the boundary check */
export function assertInsideRoot(root: string, p: string) {
    const base = path.resolve(root);
    const resolved = path.resolve(p);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new Error('path escaped content root');
    return resolved;
}

/*
 * realpath the parent, assert it's in the root, then open the leaf O_NOFOLLOW. If the
 * leaf is a symlink the open comes back ELOOP — it's a trap, and we don't follow it
 * out of the root. The fd binds the inode at open time, so there's no
 * check-then-use-by-path race: validation and read hit the same inode. Caller closes
 * the returned handle.
 */
export async function openInRoot(root: string, p: string, flags: number) {
    const realRoot = await realpath(path.resolve(root));
    const realDir = await realpath(path.dirname(p));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error('parent escaped content root');
    return open(p, flags | constants.O_NOFOLLOW);
}

/* text read through the O_NOFOLLOW path. regular-file check first so a fifo or device
 * node someone committed into the repo can't hang or misbehave on read */
export async function readInRoot(root: string, p: string): Promise<string> {
    const fh = await openInRoot(root, p, constants.O_RDONLY);
    try {
        if (!(await fh.stat()).isFile()) throw new Error('not a regular file');
        return await fh.readFile('utf8');
    } finally {
        await fh.close();
    }
}

/* binary read variant. optional size cap so a giant push can't OOM the box */
export async function readBytesInRoot(root: string, p: string, maxBytes?: number): Promise<Uint8Array> {
    const fh = await openInRoot(root, p, constants.O_RDONLY);
    try {
        const st = await fh.stat();
        if (!st.isFile()) throw new Error('not a regular file');
        if (maxBytes !== undefined && st.size > maxBytes) throw new Error('file too large');
        return await fh.readFile();
    } finally {
        await fh.close();
    }
}

/* write through the same O_NOFOLLOW path: the leaf opens O_NOFOLLOW so a symlinked
 * target can't redirect the write outside the root, and openInRoot already
 * realpath-checked the parent. O_TRUNC for a clean overwrite. Parent dir has to exist
 * — the caller creates it, and that mkdir stays inside the root. */
export async function writeInRoot(root: string, p: string, data: string | Uint8Array) {
    const fh = await openInRoot(root, p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
    try {
        await fh.writeFile(data);
    } finally {
        await fh.close();
    }
}
