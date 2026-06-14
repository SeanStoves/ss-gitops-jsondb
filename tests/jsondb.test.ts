import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, listJson, writeJson, removeJson } from '../src/jsondb.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

// a bare "remote" + a working clone seeded with a couple of records, on `main`
async function setup() {
    const base = await mkdtemp(path.join(tmpdir(), 'jsondb-'));
    const bare = path.join(base, 'remote.git');
    const work = path.join(base, 'content');
    // -b main on BOTH: a fresh runner has no init.defaultBranch, so without this the bare's
    // HEAD points at 'master', the seed pushes to 'main', and `git clone` checks out an empty
    // working tree — which silently made verify-clone reads return null in CI.
    git(base, 'init', '-b', 'main', '--bare', 'remote.git');
    git(base, 'init', '-b', 'main', 'content');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    await writeFile(path.join(work, 'home.json'), '{"name":"home"}\n');
    await mkdir(path.join(work, 'blog'), { recursive: true });
    await writeFile(path.join(work, 'blog', 'first.json'), '{"title":"first"}\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-m', 'seed');
    git(work, 'remote', 'add', 'origin', bare);
    git(work, 'push', '-u', 'origin', 'main');
    // token is a dummy: the remote is a local path so the http auth header is never used
    const cfg = { contentDir: work, remoteUrl: 'https://example.invalid/' };
    return { base, bare, work, cfg, token: 'unused-for-local-remote' };
}

test('readJson: hit, nested hit, miss, and traversal are handled', async () => {
    const { base, work } = await setup();
    try {
        assert.deepEqual(await readJson(work, 'home'), { name: 'home' });
        assert.deepEqual(await readJson(work, 'home.json'), { name: 'home' }); // ext optional
        assert.deepEqual(await readJson(work, 'blog/first'), { title: 'first' });
        assert.equal(await readJson(work, 'does-not-exist'), null);
        assert.equal(await readJson(work, '../../etc/passwd'), null); // traversal -> null, never reads outside
        assert.equal(await readJson(work, 'blog/../../escape'), null);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('listJson: root and a subdir, sorted, .json only', async () => {
    const { base, work } = await setup();
    try {
        await writeFile(path.join(work, 'projects.json'), '{}\n');
        await writeFile(path.join(work, 'notes.txt'), 'ignored\n'); // non-json skipped
        assert.deepEqual(await listJson(work), ['home', 'projects']);
        assert.deepEqual(await listJson(work, 'blog'), ['first']);
        assert.deepEqual(await listJson(work, 'no-such-dir'), []);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('writeJson is a commit: file lands, readable, and pushed to the remote', async () => {
    const { base, bare, work, cfg, token } = await setup();
    try {
        await writeJson(cfg, token, 'blog/second', { title: 'second' }, { message: 'content: add second', author: { name: 'Ed', email: 'ed@example.com' } });

        assert.deepEqual(await readJson(work, 'blog/second'), { title: 'second' });
        // it's an actual commit
        const log = git(work, 'log', '--oneline').toString();
        assert.match(log, /content: add second/);
        // and it reached the remote (clone the bare and check)
        const verify = path.join(base, 'verify');
        git(base, 'clone', bare, 'verify');
        assert.deepEqual(await readJson(verify, 'blog/second'), { title: 'second' });
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('removeJson is a commit: record gone, removal pushed', async () => {
    const { base, bare, work, cfg, token } = await setup();
    try {
        await removeJson(cfg, token, 'blog/first', { message: 'content: drop first', author: { name: 'Ed', email: 'ed@example.com' } });
        assert.equal(await readJson(work, 'blog/first'), null);
        const verify = path.join(base, 'verify');
        git(base, 'clone', bare, 'verify');
        assert.equal(await readJson(verify, 'blog/first'), null);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('writeJson rejects a traversal path before touching git', async () => {
    const { base, cfg, token } = await setup();
    try {
        await assert.rejects(() => writeJson(cfg, token, '../escape', { x: 1 }, { message: 'nope' }), /rejected path segment|escaped/);
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('writeJson refuses to mkdir through a symlinked parent — and creates nothing outside the root', async () => {
    const { base, work, cfg, token } = await setup();
    const outside = path.join(base, 'OUTSIDE');
    await mkdir(outside, { recursive: true });
    try {
        // a hostile push lands a symlink in the content tree pointing out of the root
        await symlink(outside, path.join(work, 'escape'));
        git(work, 'add', '-A');
        git(work, 'commit', '-m', 'add symlink');
        // writing through it must throw BEFORE the recursive mkdir can build dirs outside
        await assert.rejects(
            () => writeJson(cfg, token, 'escape/a/b/c/rec', { x: 1 }, { message: 'attack' }),
            /escaped content root/,
        );
        assert.deepEqual(await readdir(outside), []); // nothing got created out past the root
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});
