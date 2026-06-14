/*
 * The eviction matrix, framework-free. Given the files a webhook/write touched, this
 * hands back ONLY the paths to evict — it does not call revalidatePath or anything
 * else. Eviction is data here; the caller (a Next route, an Express handler, a CDN
 * purge script) decides what to do with the list.
 *
 * The matrix is config-driven, not hardcoded. A rule either:
 *   - matches a fixed file path (`file`), or
 *   - matches a regex with one capture group (`pattern` + `evict(slug)`),
 * and contributes paths to kill. `also` paths fire whenever any rule in the group
 * matches — that's how one blog post edit also busts /blog and /.
 */

export type StaticRule = {
    /* exact on-disk path, repo-relative, e.g. 'resume/resume.json' */
    file: string;
    /* paths to evict when this file changes */
    evict: string[];
};

export type PatternRule = {
    /* regex with exactly one capture group, e.g. /^blog\/(.+)\.md$/. HEADS UP: this runs
     * against changed-FILE names, and those are attacker-controlled — anyone with push
     * access picks the filenames. KEEP IT LINEAR: no nested quantifiers like (.+)+ or
     * (a|a)*, or you've handed a push-access attacker a ReDoS that wedges the webhook.
     * the shipped examples are linear-safe; input is also length-capped before it lands here. */
    pattern: RegExp;
    /* the capture has to pass this before it's used — anything from a filename is
     * untrusted. defaults to the slug whitelist if omitted */
    slugRe?: RegExp;
    /* map a matched capture (the slug) to the paths to evict */
    evict: (slug: string) => string[];
    /* extra paths to evict whenever ANY file matches this rule (list/index views) */
    also?: string[];
};

export type EvictionConfig = {
    static?: StaticRule[];
    patterns?: PatternRule[];
};

const DEFAULT_SLUG_RE = /^[a-zA-Z0-9-_]+$/;
// a changed-file path is attacker-controlled (it comes off a push). git won't produce a
// real content path anywhere near this long, so anything past it is junk — drop it before
// it reaches a config regex, which bounds the worst case a custom pattern can be driven to.
const MAX_PATH = 1024;

export function evictForFiles(changedFiles: string[], config: EvictionConfig): string[] {
    const evicted = new Set<string>();
    const statics = config.static ?? [];
    const patterns = (config.patterns ?? []).map((rule) => ({ rule, hit: false }));

    for (const file of changedFiles) {
        if (file.length > MAX_PATH) continue; // junk-length path, don't hand it to any matcher
        for (const entry of patterns) {
            const { rule } = entry;
            const m = rule.pattern.exec(file);
            if (!m) continue;
            const slug = m[1];
            const slugRe = rule.slugRe ?? DEFAULT_SLUG_RE;
            if (slug === undefined || !slugRe.test(slug)) continue;
            // EXTERMINATE — everything this rule names goes in the kill set
            for (const p of rule.evict(slug)) evicted.add(p);
            entry.hit = true;
        }

        for (const rule of statics) {
            if (rule.file === file) for (const p of rule.evict) evicted.add(p);
        }
    }

    for (const { rule, hit } of patterns) {
        if (hit && rule.also) for (const p of rule.also) evicted.add(p);
    }

    return [...evicted];
}
