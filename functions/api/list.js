// functions/api/list.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY = "site:posts:list";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  // 1) 动态计算 KV 缓存键：分类转换为纯小写防错，避免大小写导致的多份缓存
  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;
  const currentKvKey = formattedCategory ? `site:posts:list:cat:${formattedCategory}` : KV_LIST_KEY;

  try {
    // 2) 无论是全局列表还是分类列表，全部优先走 KV 缓存，极大保护 D1
    const cachedList = await env.KV.get(currentKvKey);
    if (cachedList) {
      return new Response(cachedList, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=10, s-maxage=60" // 边缘 CDN 允许缓存 60 秒
        }
      });
    }

    // 3) 缓存未命中，获取全局摘要裁剪长度配置
    //    优先复用 settings.js 维护的 site:settings:data 快照，省一次 D1 往返
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

    // 4) 回源 D1 拉取数据。注意：此处改拿 content，用于在内存中即时生成最新摘要
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

    // 5) 💡 动态组装：在内存中裁剪最新的摘要，彻底省去数据库更新导致的性能爆炸
    const data = posts.map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      category: (!p.category || p.category.trim() === '') ? null : p.category,
      views: p.views,
      created_at: p.created_at,
      excerpt: makeExcerpt(p.content || '', excerptLength) // 运行时动态生成
    }));

    const responseData = { success: true, data };
    const responseString = JSON.stringify(responseData);

    // 6) 异步回填到对应的 KV 中（缓存 12 小时，文章增删改时会主动使该缓存失效）
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