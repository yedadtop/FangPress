// functions/api/list.js
import { makeExcerpt } from "./helpers.js";

const KV_LIST_KEY_PREFIX = "site:posts:list:page:"; 
const KV_CAT_KEY_PREFIX = "site:posts:list:cat:";    
const KV_SETTINGS_KEY = "site:settings:data";
const PAGE_SIZE = 10;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');
  const pageParam = url.searchParams.get('page');

  const isPaginated = pageParam !== null;
  let page = 1;
  if (isPaginated) {
    page = parseInt(pageParam, 10);
    if (isNaN(page) || page < 1) page = 1;
  }

  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;
  
  // ⚡ 核心判断：是否为管理后台的全量请求（无分类且无分页）
  const isAdminQuery = !formattedCategory && !isPaginated;
  
  let currentKvKey = null;
  if (formattedCategory) {
    currentKvKey = `${KV_CAT_KEY_PREFIX}${formattedCategory}`;
  } else if (isPaginated) {
    currentKvKey = `${KV_LIST_KEY_PREFIX}${page}`;
  }
  // 💡 如果是 isAdminQuery，currentKvKey 保持为 null，彻底绕过 KV 缓存

  try {
    // 只有前台请求才尝试读取缓存
    if (currentKvKey) {
      const cachedList = await env.KV.get(currentKvKey);
      if (cachedList) {
        return new Response(cachedList, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=10, s-maxage=60"
          }
        });
      }
    }

    // --- 处理摘要长度设置 ---
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
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      );
    } else {
      // ⚡ 修复 2：管理后台查询去除 LIMIT 100，确保加载所有文章
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, views, created_at, status
         FROM posts
         ORDER BY created_at DESC`
      );
    }
    
    const { results } = await stmt.all();
    const rawResults = results || [];

    let hasMore = false;
    let pageResults = rawResults;

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
      status: p.status || 'published', // 后台可以读取这个字段区分草稿
      excerpt: makeExcerpt(p.content || '', excerptLength)
    }));

    const responseData = (!formattedCategory && isPaginated)
      ? { success: true, data, has_more: hasMore }
      : { success: true, data };
      
    const responseString = JSON.stringify(responseData);

    // ⚡ 仅当是前台请求时（currentKvKey 存在），才将结果回填到缓存
    if (currentKvKey) {
      context.waitUntil(
        env.KV.put(currentKvKey, responseString, { expirationTtl: 43200 })
          .catch(err => console.error('KV put list failed (list.js):', err))
      );
    }

    return new Response(responseString, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}