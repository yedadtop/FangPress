// functions/api/list.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY_PREFIX = "site:posts:list:page:"; 
const KV_CAT_KEY_PREFIX = "site:posts:list:cat:";    
const KV_SETTINGS_KEY = "site:settings:data";
// ⚡ 恢复给管理后台使用的全量缓存键名
const KV_ADMIN_LIST_KEY = "site:posts:list"; 
const PAGE_SIZE = 10;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');
  const pageParam = url.searchParams.get('page');

  // ⚡ 核心修复：判断是否明确要求分页。管理后台不传 page，所以 isPaginated 会是 false
  const isPaginated = pageParam !== null;
  let page = 1;
  if (isPaginated) {
    page = parseInt(pageParam, 10);
    if (isNaN(page) || page < 1) page = 1;
  }

  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;
  
  // ⚡ 根据请求来源，路由到不同的缓存键
  let currentKvKey;
  if (formattedCategory) {
    currentKvKey = `${KV_CAT_KEY_PREFIX}${formattedCategory}`;
  } else if (isPaginated) {
    currentKvKey = `${KV_LIST_KEY_PREFIX}${page}`;
  } else {
    currentKvKey = KV_ADMIN_LIST_KEY; // 管理后台走专属全量缓存
  }

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

    // --- 处理摘要长度设置 (逻辑不变) ---
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

    // --- 动态构建查询语句 ---
    let stmt;
    if (formattedCategory) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(formattedCategory);
    } else if (isPaginated) {
      // ⚡ 分页查询：LIMIT 11
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      );
    } else {
      // ⚡ 管理后台查询：获取全量 100 篇
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      );
    }
    
    const { results } = await stmt.all();
    const rawResults = results || [];

    let hasMore = false;
    let pageResults = rawResults;

    // ⚡ 仅对没有分类且明确要求分页的请求，执行 10 条切片
    if (!formattedCategory && isPaginated) {
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

    // 根据不同请求返回带或不带 has_more 字段的数据
    const responseData = (!formattedCategory && isPaginated)
      ? { success: true, data, has_more: hasMore }
      : { success: true, data };
      
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