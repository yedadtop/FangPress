// functions/api/list.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY = "site:posts:list";
const KV_SETTINGS_KEY = "site:settings:data"; // ⚡ 修复：必须明确声明此键名，否则抛出全局 ReferenceError

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;
  const currentKvKey = formattedCategory ? `site:posts:list:cat:${formattedCategory}` : KV_LIST_KEY;

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
      const settingsCache = await env.KV.get(KV_SETTINGS_KEY); // ⚡ 修复后此处可以正常工作，不再崩溃进入 catch
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
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(formattedCategory);
    } else {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      );
    }
    const { results } = await stmt.all();
    const posts = results || [];

    const data = posts.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      category: (!p.category || p.category.trim() === '') ? null : p.category,
      views: p.views,
      created_at: p.created_at,
      excerpt: makeExcerpt(p.content || '', excerptLength)
    }));

    const responseData = { success: true, data };
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