import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evictForFiles, type EvictionConfig } from '../src/eviction.ts';

const cfg: EvictionConfig = {
    patterns: [{ pattern: /^blog\/(.+)\.md$/, evict: (s) => [`/blog/${s}`], also: ['/blog', '/'] }],
    static: [{ file: 'home.json', evict: ['/'] }],
};

test('pattern + also + static all contribute', () => {
    assert.deepEqual(evictForFiles(['blog/hello.md', 'home.json'], cfg).sort(), ['/', '/blog', '/blog/hello']);
});

test('slug whitelist rejects a path-y capture', () => {
    // (.+) would capture '../etc'; the default slug whitelist throws it out, evicts nothing
    assert.deepEqual(evictForFiles(['blog/../etc.md'], cfg), []);
});

test('a junk-length filename is dropped before any config regex runs (no ReDoS)', () => {
    // a deliberately catastrophic operator regex; the length cap must stop the attacker-
    // controlled long filename from ever reaching it. without the cap this wedges forever.
    const evil: EvictionConfig = { patterns: [{ pattern: /^(.+)+\.md$/, evict: (s) => [`/x/${s}`] }] };
    const longFile = 'a'.repeat(5000) + '!.md'; // 5004 chars, way over MAX_PATH
    const t = Date.now();
    const out = evictForFiles([longFile], evil);
    assert.ok(Date.now() - t < 200, `must return fast, took ${Date.now() - t}ms`);
    assert.deepEqual(out, []);
});
