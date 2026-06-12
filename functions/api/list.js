// functions/api/list.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY_PREFIX = "site:posts:list:page:"; // 无分类分页键前缀
const KV_CAT_KEY_PREFIX = "site:posts:list:cat:";    // 分类键（暂不引入分页，保持原结构）
const KV_SETTINGS_KEY = "site:settings:data";
const PAGE_SIZE = 10;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  // ⚡ 新增：解析分页参数（默认 1，防御 NaN / 负数）
  let page = parseInt(url.searchParams.get('page') || '1', 10);
  if (isNaN(page) || page < 1) page = 1;

  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;
  // ⚡ 改动点：无 category 时使用分页键 site:posts:list:page:<n>；有 category 时键名不变
  const currentKvKey = formattedCategory
    ? `${KV_CAT_KEY_PREFIX}${formattedCategory}`
    : `${KV_LIST_KEY_PREFIX}${page}`;

  try {
    const cachedList = await env.KV.get(currentKvKey);
    if (cachedList) {
      return new Response(cachedList, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=10, s-maxage=60"
        }
      });
    }

    let excerptLength = 200;
    try {
      const settingsCache = await env.KV.get(KV_SETTINGS_KEY);
      let resolved = false;
      if (settingsCache) {
        try {
          const parsed = JSON.parse(settingsCache);
          const v = parsed && parsed.data && parsed.data.excerpt_length;
          if (v != null) {
            const n = parseInt(String(v).trim(), 10);
            if (Number.isInteger(n)) { excerptLength = n; resolved = true; }
          }
        } catch (_) {}
      }
      if (!resolved) {
        const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'excerpt_length'").first();
        if (row && row.value != null) {
          excerptLength = parseInt(String(row.value).trim(), 10);
        }
      }
    } catch (_) {}

    let stmt;
    if (formattedCategory) {
      // 分类场景：暂保留原 LIMIT 100 行为（未分页）
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(formattedCategory);
    } else {
      // ⚡ 改动点：使用 LIMIT 11 + OFFSET 探测下一页
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      );
    }
    const { results } = await stmt.all();
    const rawResults = results || [];

    // ⚡ 改动点：无分类场景下探测 has_more 并切片
    let hasMore = false;
    let pageResults = rawResults;
    if (!formattedCategory) {
      hasMore = rawResults.length > PAGE_SIZE;
      if (hasMore) pageResults = rawResults.slice(0, PAGE_SIZE);
    }

    const data = pageResults.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      category: (!p.category || p.category.trim() === '') ? null : p.category,
      views: p.views,
      created_at: p.created_at,
      excerpt: makeExcerpt(p.content || '', excerptLength)
    }));

    // ⚡ 改动点：无分类场景下返回结构加入 has_more 字段
    const responseData = formattedCategory
      ? { success: true, data }
      : { success: true, data, has_more: hasMore };
    const responseString = JSON.stringify(responseData);

    context.waitUntil(
      env.KV.put(currentKvKey, responseString, { expirationTtl: 43200 })
        .catch(err => console.error('KV put list failed (list.js):', err))
    );

    return new Response(responseString, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
