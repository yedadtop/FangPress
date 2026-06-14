// functions/lib/r2-images.js
// ⚡ 从 Markdown 内容中抽取属于本博客 R2 桶的图片 key，并提供 R2 批量删除能力。
// 匹配规则：仅识别 ![alt](https://R2_PUBLIC_URL/...) 形式的外链图，不处理相对路径。

/**
 * 从 Markdown 内容中抽取 R2 图片 key 列表。
 * @param {string} content Markdown 正文
 * @param {object} env Cloudflare 环境（含 R2_PUBLIC_URL）
 * @returns {string[]} R2 对象 key 数组（已去重）
 */
export function extractR2Keys(content, env) {
    if (!content || typeof content !== 'string' || !env || !env.R2_PUBLIC_URL) return [];
    const base = String(env.R2_PUBLIC_URL).replace(/\/+$/, '');
    if (!base) return [];

    // 匹配 Markdown 图片语法：![alt](url)，允许 url 带可选 title
    // 例：![alt](https://x.com/a.png) / ![alt](https://x.com/a.png "title")
    const re = /!\[[^\]]*\]\(\s*<?([^()\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
    const keys = new Set();
    let m;
    while ((m = re.exec(content)) !== null) {
        const url = String(m[1]).replace(/[<>]/g, '').trim();
        if (url.startsWith(base + '/')) {
            // 取 base 之后的部分作为 R2 key（去除可能的 query / hash）
            let key = url.slice(base.length + 1);
            const qIdx = key.search(/[?#]/);
            if (qIdx >= 0) key = key.slice(0, qIdx);
            if (key) keys.add(key);
        }
    }
    return Array.from(keys);
}

/**
 * 批量删除 R2 对象（不抛错，单条失败不影响其他）。
 * @param {object} env Cloudflare 环境（含 R2_BUCKET）
 * @param {string[]} keys 待删除的 R2 key 列表
 */
export async function deleteR2Images(env, keys) {
    if (!env || !env.R2_BUCKET || !Array.isArray(keys) || keys.length === 0) return { ok: 0, fail: 0 };
    let ok = 0, fail = 0;
    // 优先走批量 delete
    try {
        await env.R2_BUCKET.delete(keys);
        ok = keys.length;
    } catch (_) {
        // 批量失败时逐条兜底
        for (const k of keys) {
            try {
                await env.R2_BUCKET.delete(k);
                ok++;
            } catch (e) {
                fail++;
                console.warn('R2 delete failed for key:', k, e);
            }
        }
    }
    return { ok, fail };
}

/**
 * 一站式：从 content 抽取 R2 key 并删除。
 * @param {object} env Cloudflare 环境
 * @param {string} content Markdown 正文
 * @returns {{ keys: string[], ok: number, fail: number }}
 */
export async function cleanupR2ImagesFromContent(env, content) {
    const keys = extractR2Keys(content, env);
    if (keys.length === 0) return { keys: [], ok: 0, fail: 0 };
    const result = await deleteR2Images(env, keys);
    return { keys, ...result };
}
