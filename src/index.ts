/*
 * ss-gitops-jsondb — GitHub App content-sync bits.
 *
 * Mint an App installation token, check webhook signatures, pull/push a content repo
 * over git with the token kept out of argv, and work out which paths to evict. Native
 * Node, zero runtime deps. Session/auth is deliberately someone else's problem.
 */

export { installationToken, type AppConfig } from './github.ts';
export { verifyGithubSig } from './webhook-sig.ts';
export {
    run,
    status,
    headSha,
    addAll,
    commit,
    pull,
    push,
    changedFiles,
    type GitConfig,
    type GitResult,
} from './git.ts';
export {
    evictForFiles,
    type EvictionConfig,
    type StaticRule,
    type PatternRule,
} from './eviction.ts';
export {
    safePath,
    assertInsideRoot,
    openInRoot,
    readInRoot,
    readBytesInRoot,
    SLUG_RE,
} from './safe-fs.ts';
export {
    handleWebhook,
    type WebhookOptions,
    type WebhookResult,
} from './webhook.ts';
export {
    readJson,
    listJson,
    writeJson,
    removeJson,
    type WriteOptions,
} from './jsondb.ts';
