import { mkdir, rm, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safePath, openInRoot, readInRoot, writeInRoot } from './safe-fs.ts';
import { pull, addAll, commit, push, type GitConfig } from './git.ts';
import { constants } from 'node:fs';

/*
 * A JSON store where git is the database — no Postgres, no Mongo, no daemon. Records are
 * files, indexes are folders, history is `git log`, backup is a clone. Reads go through
 * the O_NOFOLLOW + slug-whitelist + inside-root guards, because the on-disk tree is
 * push-writable and that makes it a hostile boundary. A write is a git commit:
 * pull -> write -> commit -> push.
 *
 * No query language, no schema enforcement — validate your own shape BEFORE writeJson.
 * This layer guards paths and durability, not your types. Single-writer by design, no
 * locking: if two writers race the second push is rejected and you retry. That's the
 * boring, correct behaviour for one admin editing content.
 */

export type WriteOptions = {
    message: string;
    author?: { name: string; email: string };
    /* JSON.stringify indent. default 2 spaces; pass 4 to match a hand-edited tree, 0 to minify */
    indent?: number;
};

const withJson = (rel: string) => (rel.endsWith('.json') ? rel : `${rel}.json`);
const segs = (rel: string) => rel.split('/').filter(Boolean);

/*
 * Read + parse a record. A missing / unreadable / out-of-root path is null — an absent
 * record, not an error. Malformed JSON THROWS — a corrupt record is a real problem you
 * want to hear about, not swallow as "not found".
 */
export async function readJson<T = unknown>(root: string, relPath: string): Promise<T | null> {
    let abs: string;
    try {
        abs = safePath(root, ...segs(withJson(relPath)));
    } catch {
        return null; // bad path segment / escaped root -> treat as not found
    }
    let text: string;
    try {
        text = await readInRoot(root, abs);
    } catch {
        return null; // ENOENT / not a regular file / symlinked leaf -> not found
    }
    return JSON.parse(text) as T;
}

/*
 * Slugs (filename minus .json) of the records in a directory, sorted. Defaults to the
 * root. Non-.json files, directories, and odd entries get skipped; the listing dir is
 * realpath-checked inside the root before it's read.
 */
export async function listJson(root: string, dir = ''): Promise<string[]> {
    const absDir = dir ? safePath(root, ...segs(dir)) : path.resolve(root);
    const realRoot = await realpath(path.resolve(root));
    let realDir: string;
    try {
        realDir = await realpath(absDir);
    } catch {
        return []; // missing dir -> empty listing
    }
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error('dir escaped content root');
    const entries = await readdir(absDir, { withFileTypes: true });
    return entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name.slice(0, -'.json'.length))
        .sort();
}

/*
 * realpath the nearest ancestor of `target` that actually exists and prove it resolves
 * inside the root. the leaf dirs might not exist yet (a brand new collection), so climb
 * up on ENOENT until something real answers. this RESOLVES symlinks — a lexical check
 * doesn't, and a pushed symlink in the path would let a later mkdir(recursive) build dirs
 * out past the root before the write itself gets blocked. it's a trap; we spot it first.
 */
async function assertRealAncestorInsideRoot(root: string, target: string) {
    const realRoot = await realpath(path.resolve(root));
    let p = path.resolve(target);
    for (;;) {
        try {
            const real = await realpath(p);
            if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('parent escaped content root');
            return;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // a real escape, ELOOP, or a perms error — fail closed
            const up = path.dirname(p);
            if (up === p) throw new Error('parent escaped content root'); // walked to the fs root without landing in ours
            p = up;
        }
    }
}

/*
 * Write a record and commit it: pull -> check parent -> write (O_NOFOLLOW) -> add -> commit
 * -> push. The pull is ff-only; if the remote moved underneath us the push is rejected and
 * this throws — the single writer retries. Validate `data`'s shape yourself first.
 */
export async function writeJson(git: GitConfig, token: string, relPath: string, data: unknown, opts: WriteOptions): Promise<void> {
    const root = git.contentDir;
    const abs = safePath(root, ...segs(withJson(relPath)));

    await pull(git, token); // land on latest before writing so the push fast-forwards

    // resolve symlinks BEFORE mkdir, not just lexically after — otherwise mkdir builds the
    // path out through a pushed symlink and leaves empty dirs outside the root
    const parent = path.dirname(abs);
    await assertRealAncestorInsideRoot(root, parent);
    await mkdir(parent, { recursive: true }); // new folder for a new collection, no problem
    await writeInRoot(root, abs, JSON.stringify(data, null, opts.indent ?? 2) + '\n');

    await addAll(git);
    await commit(git, opts.message, opts.author);
    await push(git, token);
}

/*
 * Delete a record and commit the removal: pull -> rm -> add -> commit -> push. The
 * parent gets realpath-checked inside the root first so a symlinked directory can't
 * redirect the delete outside the tree. Deleting a missing record is a no-op.
 */
export async function removeJson(git: GitConfig, token: string, relPath: string, opts: WriteOptions): Promise<void> {
    const root = git.contentDir;
    const abs = safePath(root, ...segs(withJson(relPath)));

    await pull(git, token);

    await assertRealAncestorInsideRoot(root, path.dirname(abs)); // symlinked parent can't redirect the delete out
    await rm(abs, { force: true });

    await addAll(git);
    await commit(git, opts.message, opts.author);
    await push(git, token);
}

// re-export so a consumer can hand-roll reads/writes against the same guards once they
// outgrow the four helpers above
export { openInRoot, readInRoot, writeInRoot, constants as fsConstants };
