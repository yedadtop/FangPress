// functions/api/list.js

const KV_LIST_KEY = "site:posts:list";

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');

  try {
    // 1) 只有在没有分类筛选时，才走全局 KV 列表缓存（分类筛选频率低，直接走 D1）
    if (!categoryParam) {
      const cachedList = await env.KV.get(KV_LIST_KEY);
      if (cachedList) {
        return new Response(cachedList, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=10, s-maxage=60"
          }
        });
      }
    }

    // 2) 缓存未命中或存在分类参数，回源 D1
    let stmt;
    if (categoryParam) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, excerpt, created_at
         FROM posts
         WHERE category = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(categoryParam);
    } else {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, category, views, excerpt, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      );
    }
    const { results } = await stmt.all();
    const posts = results || [];

    const data = posts.map(p => ({
      ...p,
      category: (!p.category || p.category.trim() === '') ? null : p.category
    }));

    const responseData = { success: true, data };
    const responseString = JSON.stringify(responseData);

    // 3) 如果是全局无筛选列表，异步异步写入 KV 供下次秒开
    if (!categoryParam) {
      context.waitUntil(env.KV.put(KV_LIST_KEY, responseString));
    }

    return new Response(responseString, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}