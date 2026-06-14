# ss-gitops-jsondb

[![npm](https://img.shields.io/npm/v/@seanstoves/ss-gitops-jsondb?logo=npm&color=cb3837)](https://www.npmjs.com/package/@seanstoves/ss-gitops-jsondb) [![CI](https://github.com/SeanStoves/ss-gitops-jsondb/actions/workflows/ci.yml/badge.svg)](https://github.com/SeanStoves/ss-gitops-jsondb/actions/workflows/ci.yml)

> **Provenance.** I wrote this code for my own site ([seanstoves.com](https://seanstoves.com)).
> [Claude Code](https://claude.com/claude-code) did the work of ripping it out of the app,
> decoupling it, and cleaning it up for distribution — I reviewed every line, but that's the
> honest origin story. Either way: read it before you trust it. You should do that with any
> dependency you didn't write — especially one that handles a write-capable token.

**Your JSON files in git, used as a database — plus the GitHub-App loop that keeps
them live.** No Postgres, no Mongo, no daemon. Records are files, indexes are folders,
history is `git log`, backup is a clone. A write is a commit; a push fires a webhook;
the app pulls and evicts only the pages that changed.

Two halves, use either or both:

1. **A JSON store over git.** `readJson` / `listJson` / `writeJson` / `removeJson`, where
   every read goes through hostile-input filesystem guards and every write is a real
   git commit. Git is the durable layer.
2. **The sync machinery.** Mint a GitHub App installation token with native Web Crypto
   (no `jsonwebtoken`, no `octokit`), verify inbound webhooks in constant time, pull/push
   over git **with the token never touching argv**, and compute exactly which cache
   paths to evict.

Extracted from a production site ([seanstoves.com](https://seanstoves.com)) and
genericized so you can run the same thing.

- **Zero runtime dependencies.** Native Node 20+ only (`crypto.subtle`, `child_process`,
  `fs`). Nothing to audit for CVEs but Node itself.
- **Framework-agnostic core** + thin, copy-and-edit adapters for Next.js and Express.
- **Auth is intentionally out of scope.** This is the data + sync layer. Bring your own
  sessions/OAuth — a write-capable token minter has no business sharing a package with
  your auth.

MIT licensed. Use it, fork it, ship it.

---

## Security scan

Last run **2026-06-14** against this repo's source. This one mints a write-capable token and writes
files, so it got hammered harder than a markdown lib needs to. Re-run any row yourself.

| Area | What I tested | Result / posture |
|---|---|---|
| Supply chain | `npm audit` + retire.js 5.4.3; runtime-dependency count | **0 vulnerabilities, 0 runtime deps** — no transitive tree to track |
| Secrets | secretlint (recommend preset, validated against a planted token) + manual PEM / `.env` / credential sweep | **clean** — no keys, no `.env`, only empty placeholders |
| Credential handling | token must never reach argv / `/proc/<pid>/cmdline`; webhook HMAC constant-time, raw-body, verify-before-parse; App key non-extractable | **holds** — token rides `GIT_CONFIG` only (confirmed at the OS boundary with a wrapped `git`), HMAC unbypassable, key non-extractable, cache key hardened injective |
| Path / filesystem safety | traversal, absolute paths, the `..json` dot-collapse; symlinked leaf / parent / nested dir on read, write, and delete — with **real committed symlinks** in a temp repo | **contained** — `safePath` + `O_NOFOLLOW` + realpath-ancestor checks keep every read/write/delete inside the root |
| DoS / injection | eviction-regex ReDoS, SHA option-injection, argv-only spawn, output buffering | **bounded** — SHAs validated, no shell, git output capped; eviction input length-capped + the linear-pattern requirement documented on `PatternRule` |
| Tests (`npm test`) | traversal & symlink-escape rejection, constant-time HMAC, write-is-a-commit, eviction ReDoS cap | **17 / 17** |
| Adversarial review | 3 lenses — path-safety · credential-handling · DoS — run for real against a live temp repo | **2 medium + 3 low found → all fixed and regression-tested, 0 outstanding** |
| License | — | **MIT**, zero deps |

I'd rather show you the review found things and I fixed them than pretend it came back spotless. The two
mediums were a `mkdir` that could build empty dirs outside the root through a pushed symlink (now realpath-
checked before the write) and a ReDoS reachable only if *you* write a catastrophic eviction regex (now
input-capped and documented). Both have a regression test. As always: the recommended install is
**Option B — vendor it and read it.**

---

## Install — pick your supply-chain tolerance

**A. From npm** — published with signed provenance, zero runtime deps:

```sh
npm install @seanstoves/ss-gitops-jsondb
# `next` is an optional peer dep, only for the Next adapter
```

> **Real talk: I'd skip this and vendor it (Option B).** Yes, it's on npm for convenience — but
> even a zero-dependency package is still a supply-chain link you're choosing to trust: a future
> release, a hijacked account, a typosquatted name one fat-finger away. This thing mints a
> write-capable token and touches your filesystem — exactly the code you want to read in one sitting
> and *own outright*, not pull blind from a registry. Cloning the files in is the move I'd make.

**B. Vendor it (zero dependencies, including this one).** The whole library is native
TypeScript — every import is from `node:*`. Copy `src/` into your project and import
locally; now you depend on no registry at all. This is the strongest version of "no
supply chain," and honestly the one I'd pick — read the ~600 lines once, own them, no
transitive deps, no Dependabot, no 3am CVE page.

```sh
# grab src/ straight from GitHub (or out of node_modules) into your tree
cp -r path/to/ss-gitops-jsondb/src src/lib/gitops
```

Either way you need **Node 20+** (stable `crypto.subtle` + `fetch`).

---

## The JSON store

Reads are traversal- and symlink-proof (the on-disk tree is push-writable, so it's a
hostile boundary). A write does `pull → write → commit → push` — durability is git's job.

```ts
import { readJson, listJson, writeJson, removeJson } from '@seanstoves/ss-gitops-jsondb';

// READ — missing/out-of-root is null; malformed JSON throws (a corrupt record is a real problem)
const home = await readJson<{ name: string }>(CONTENT_DIR, 'home');          // home.json
const post = await readJson(CONTENT_DIR, 'blog/first');                      // blog/first.json

// LIST — slugs of the .json records in a folder, sorted
const slugs = await listJson(CONTENT_DIR, 'blog');                           // ['first', 'second']

// WRITE — this is a git commit. validate your shape FIRST; this guards paths + durability, not types.
await writeJson(git, token, 'blog/second', { title: 'Second' }, {
    message: 'content: add second post',
    author: { name: 'Editor', email: 'editor@example.com' },
});

// DELETE — also a commit
await removeJson(git, token, 'blog/first', { message: 'content: drop first' });
```

`git` is a `GitConfig` (`{ contentDir, remoteUrl }`) and `token` comes from
`installationToken` (below). Single-writer by design — no locking; if two writers race,
the second push is rejected and you retry, which is the correct boring behaviour for one
admin editing content.

---

## The sync loop

### Setup: register the GitHub App

> **Accurate as of 2026-06-14.** GitHub moves these screens around — if a label has
> changed, the *concepts* are what you want: an App ID, an installation ID, a Contents
> read/write permission, a Push webhook, and a private key.

You want a **GitHub App** (not an OAuth app, not a PAT) so the install is scoped to one
repo and the token it mints is short-lived.

1. **Create the App.** `github.com` → avatar → **Settings** → **Developer settings** →
   **GitHub Apps** → **New GitHub App**.
   - **Name**: anything unique, e.g. `mysite-content-sync`. **Homepage URL**: your site.
   - **Webhook**: **Active** ✔ · **URL**: `https://yoursite.com/api/webhook/git-sync` ·
     **Secret**: `openssl rand -hex 32`, saved as `GH_WEBHOOK_SECRET`.
   - **Repository permissions**: **Contents → Read and write**, **Metadata → Read-only**.
   - **Subscribe to events**: **Push** ✔. **Install on**: **Only on this account**.
   - Create it, note the **App ID** → `GH_APP_ID`.
2. **Private key.** Same page → **Generate a private key**. A `.pem` downloads (the only
   copy — store it like a password). It's a PKCS#1 PEM; the toolkit bridges it to PKCS#8
   for Web Crypto, so pass the text as-is. For env storage: `base64 -w0 your-key.pem`.
3. **Install on your content repo.** **Install App** → **Only select repositories** →
   your content repo. The install URL ends `.../installations/<INSTALLATION_ID>` →
   `GH_APP_INSTALLATION_ID`.
4. **Clone the content repo on your server** — that path is `CONTENT_DIR`.

Env (see [`.env.example`](./.env.example)):

```sh
GH_APP_ID=123456
GH_APP_INSTALLATION_ID=12345678
GH_APP_PRIVATE_KEY=<base64 of the .pem>      # decode before handing it to the lib
GH_WEBHOOK_SECRET=<the openssl rand value>
CONTENT_DIR=/srv/app/content
CONTENT_REMOTE=https://github.com/           # remote base the auth header is scoped to
```

### The webhook route

`handleWebhook` runs the inbound loop framework-free — verify signature → confirm it's a
push on your branch → mint token → pull → diff the SHAs → return the paths to evict.

**Next.js** — copy [`adapters/next`](./adapters/next/index.ts) to
`app/api/webhook/git-sync/route.ts` and export `POST`:

```ts
import { revalidatePath } from 'next/cache';
import { handleWebhook, type EvictionConfig } from '@seanstoves/ss-gitops-jsondb';

const eviction: EvictionConfig = {
    patterns: [{ pattern: /^blog\/(.+)\.md$/, evict: (slug) => [`/blog/${slug}`], also: ['/blog', '/'] }],
    static: [{ file: 'home.json', evict: ['/'] }],
};

export async function POST(req: Request) {
    const raw = Buffer.from(await req.arrayBuffer()); // RAW bytes — required for the HMAC
    const result = await handleWebhook({
        rawBody: raw,
        signatureHeader: req.headers.get('x-hub-signature-256'),
        eventHeader: req.headers.get('x-github-event'),
        secret: process.env.GH_WEBHOOK_SECRET!,
        app: {
            appId: process.env.GH_APP_ID!,
            installationId: process.env.GH_APP_INSTALLATION_ID!,
            privateKeyPem: Buffer.from(process.env.GH_APP_PRIVATE_KEY!, 'base64').toString(),
        },
        git: { contentDir: process.env.CONTENT_DIR!, remoteUrl: process.env.CONTENT_REMOTE },
        eviction,
        fallbackPaths: ['/', '/blog'],
    });
    if (!result.ok) return new Response(result.reason, { status: result.status });
    for (const p of result.evictPaths) revalidatePath(p);
    return Response.json({ ok: true, files: result.changedFiles });
}
```

An **Express** example is in [`adapters/express`](./adapters/express/index.ts) — feed it
the raw body (`express.raw({ type: 'application/json' })`, **not** `express.json()`, or
the signature won't match). Point the App's webhook at the route, push, and the page updates.

### Minting a token directly

`writeJson`, `pull`, and `push` all take a token; get one with:

```ts
import { installationToken } from '@seanstoves/ss-gitops-jsondb';

const token = await installationToken({
    appId: process.env.GH_APP_ID!,
    installationId: process.env.GH_APP_INSTALLATION_ID!,
    privateKeyPem: Buffer.from(process.env.GH_APP_PRIVATE_KEY!, 'base64').toString(),
    // apiBaseUrl: 'https://ghe.example.com/api/v3'  // GitHub Enterprise
});
```

It's hour-lived, cached in memory, refreshed 5 minutes early, and keyed per
app+installation+host so a multi-app process never crosses tokens.

---

## Why the security model matters

This code moves a write-capable GitHub token and reads a push-writable tree. The details
are the point:

- **Token minted with `crypto.subtle` RS256.** The private key is a non-extractable
  `CryptoKey`, never leaves the process. No third-party JWT lib.
- **The token rides into git via `GIT_CONFIG`, never argv.** `/proc/<pid>/cmdline` is
  world-readable; an auth header there is a leak. It's injected through
  `http.<base>.extraheader` and scoped to the one remote.
- **Webhook signatures verified in constant time over the RAW body.**
  `crypto.subtle.verify`, never a hand-rolled compare. Verify before you parse — reparsing
  the JSON changes the bytes and breaks the HMAC.
- **Changed files come from the before/after SHAs, not the payload.** The payload's file
  list is attacker-influenced; diff the SHAs locally after pulling.
- **`git` is spawned argv-only, no shell.** SHAs validated before a diff range;
  `--no-renames -z` makes a rename bust both old and new paths so nothing serves stale.
- **Filesystem access is `O_NOFOLLOW` + slug-whitelisted + asserted-inside-root**, for
  both reads and `writeJson`. A symlink or `../` can't escape the content directory.
- **Eviction is data, not a side effect.** The core returns paths; the adapter decides
  how to invalidate. Nothing in the core imports Next.

---

## API

| Export | What |
|---|---|
| `readJson / listJson / writeJson / removeJson` | The git-backed JSON store. Write/remove are commits. |
| `installationToken(app)` | Cached hour-lived App token (RS256 via Web Crypto). Multi-app / GHE safe. |
| `verifyGithubSig(secret, rawBody, header)` | Constant-time HMAC check of `X-Hub-Signature-256`. |
| `handleWebhook(opts)` | Inbound orchestrator → `{ changedFiles, evictPaths }`. |
| `evictForFiles(files, config)` | Pure file→paths eviction matrix. |
| `run / status / headSha / addAll / commit / pull / push / changedFiles` | `GitConfig`-driven git ops. |
| `safePath / assertInsideRoot / openInRoot / readInRoot / readBytesInRoot / writeInRoot / SLUG_RE` | The filesystem guards. |

Types: `WriteOptions`, `AppConfig`, `GitConfig`, `GitResult`, `EvictionConfig`,
`StaticRule`, `PatternRule`, `WebhookOptions`, `WebhookResult`.

---

## What this is not

- **Not a query engine.** No SQL, no indexes beyond your folder layout, no joins. If you
  need those, you've outgrown flat files — use a database.
- **Not an auth system.** Sessions, OAuth, RBAC: deliberately left out.
- **Not a deploy tool.** It stores content and evicts cache; building and running the app
  is yours.

## Contributing

Fork it, branch, open a PR. Keep it boring on purpose:

- **Zero runtime dependencies stays zero.** This mints a write-capable token and touches the filesystem —
  a transitive dep is exactly the supply-chain risk it exists to avoid. A PR adding one to the prod tree
  won't land.
- **The tests are the contract.** `npm test` (traversal & symlink-escape rejection, constant-time HMAC,
  write-is-a-commit, eviction cap) stays green. Touch the path guards, the token handling, or the HMAC and
  you add a test that proves the property still holds *before* you change the code.
- **The boundaries don't move.** The token never reaches argv; every read/write/delete stays inside the
  content root; the webhook verifies before it parses. If a change touches any of those, say so loudly in
  the PR and bring the test.
- **Match the voice.** Comment the hard stuff, skip the obvious, no marketing words.

Found a security issue? Don't open a public issue — use GitHub's private **"Report a vulnerability"** (the
repo's Security tab), or email **sean@seanstoves.com**.

## License

[MIT](./LICENSE) © 2026 Sean Stoves
