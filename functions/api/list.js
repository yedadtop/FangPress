// functions/api/list.js
import { makeExcerpt } from "./helpers.js";
import { getSettings } from "../lib/nav-render.js";

const KV_LIST_KEY_PREFIX = "site:posts:list:type:";
// ⚡️ 推文专用 v2 缓存键：新增 author 字段，老缓存（无 author）自动失效
const KV_LIST_KEY_PREFIX_TWEET_V2 = "site:posts:list:v2:type:tweet:";
const KV_LIST_KEY_PREFIX_LEGACY = "site:posts:list:page:";
const KV_CAT_KEY_PREFIX = "site:posts:list:cat:";
const PAGE_SIZE = 10;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get('category');
  const pageParam = url.searchParams.get('page');
  const typeParam = url.searchParams.get('type'); // 新增：'post' | 'tweet' | null(全量)

  const isPaginated = pageParam !== null;
  let page = 1;
  if (isPaginated) {
    page = parseInt(pageParam, 10);
    if (isNaN(page) || page < 1) page = 1;
  }

  // ⚡ 规范化 type 参数；非法值兜底为 null（全量）
  let normalizedType = null;
  if (typeParam && (typeParam === 'post' || typeParam === 'tweet')) {
    normalizedType = typeParam;
  }

  const formattedCategory = categoryParam ? categoryParam.trim().toLowerCase() : null;

  // ⚡ 核心判断：admin 全量请求时走特殊 KV 路径，下面 currentKvKey 全程保持 null 即可

  let currentKvKey = null;
  if (normalizedType === 'tweet' && formattedCategory) {
    // 推文 + 分类（推文走 v2 键，与 tweets.js 保持一致）
    currentKvKey = `${KV_LIST_KEY_PREFIX_TWEET_V2}cat:${formattedCategory}`;
  } else if (normalizedType === 'tweet' && isPaginated) {
    // 推文分页（推文走 v2 键）
    currentKvKey = `${KV_LIST_KEY_PREFIX_TWEET_V2}page:${page}`;
  } else if (normalizedType && formattedCategory) {
    // 文章 + 分类过滤
    currentKvKey = `${KV_LIST_KEY_PREFIX}${normalizedType}:cat:${formattedCategory}`;
  } else if (normalizedType && isPaginated) {
    // 文章分页
    currentKvKey = `${KV_LIST_KEY_PREFIX}${normalizedType}:page:${page}`;
  } else if (formattedCategory && isPaginated) {
    // ⚡ 修复 1：分类 + 分页的独立缓存键（带 type 的情况在上面已处理）
    currentKvKey = `${KV_CAT_KEY_PREFIX}${formattedCategory}:page:${page}`;
  } else if (!normalizedType && isPaginated) {
    // 不带 type 不带 category 的分页（兼容历史调用）
    currentKvKey = `${KV_LIST_KEY_PREFIX_LEGACY}${page}`;
  } else if (!normalizedType && formattedCategory) {
    currentKvKey = `${KV_CAT_KEY_PREFIX}${formattedCategory}`;
  }
  // 💡 如果是 isAdminQuery，currentKvKey 保持为 null，彻底绕过 KV 缓存

  try {
    // 只有前台请求才尝试读取缓存
    if (currentKvKey) {
      const cachedList = await env.KV.get(currentKvKey).catch(() => null);
      if (cachedList) {
        return new Response(cachedList, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=10, s-maxage=60"
          }
        });
      }
    }

    // --- 处理摘要长度设置：复用 getSettings 自动走 KV → D1 → 回填 ---
    const settings = await getSettings(env, context);
    let excerptLength = 200;
    if (settings && settings.excerpt_length != null) {
      const n = parseInt(String(settings.excerpt_length).trim(), 10);
      if (Number.isInteger(n)) excerptLength = n;
    }

    // --- 动态构建查询语句 ---
    let stmt;
    if (formattedCategory && normalizedType) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND type = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(formattedCategory, normalizedType);
    } else if (formattedCategory && isPaginated) {
      // ⚡ 修复 1：分类 + 分页的独立分支，真正分页而不是全量 LIMIT 100
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      ).bind(formattedCategory);
    } else if (formattedCategory) {
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE LOWER(category) = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(formattedCategory);
    } else if (normalizedType && isPaginated) {
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE type = ? AND status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      ).bind(normalizedType);
    } else if (normalizedType) {
      // 单 type 全量（带 LIMIT 100 兜底）
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE type = ? AND status = 'published'
         ORDER BY created_at DESC LIMIT 100`
      ).bind(normalizedType);
    } else if (isPaginated) {
      const offset = (page - 1) * PAGE_SIZE;
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at
         FROM posts
         WHERE status = 'published'
         ORDER BY created_at DESC
         LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`
      );
    } else {
      // ⚡ 修复 2：管理后台查询去除 LIMIT 100，确保加载所有文章
      stmt = env.DB.prepare(
        `SELECT id, title, slug, content, category, type, views, created_at, status
         FROM posts
         ORDER BY created_at DESC`
      );
    }

    const { results } = await stmt.all();
    const rawResults = results || [];

    let hasMore = false;
    let pageResults = rawResults;

    // ⚡ 修复 2：分页请求（含分类 + 分页、type + 分页、纯分页）都要探测下一页
    if (isPaginated) {
      hasMore = rawResults.length > PAGE_SIZE;
      if (hasMore) pageResults = rawResults.slice(0, PAGE_SIZE);
    }

    // ⚡ 推特式样所需: 仅当查询包含推文时,才去 D1 取一次首条用户的昵称+头像
    //   单用户系统下所有推文共用同一 author;其他类型不带 author 保持 payload 精简
    const needsAuthor = pageResults.some(p => (p.type || 'post') === 'tweet');
    let author = null;
    if (needsAuthor) {
      try {
        const userRow = await env.DB.prepare(
          `SELECT nickname, avatar FROM users ORDER BY id ASC LIMIT 1`
        ).first();
        if (userRow) author = { nickname: userRow.nickname || null, avatar: userRow.avatar || null };
      } catch (_) { /* 静默,允许 author 为 null,前端会显示默认昵称 + 占位头像 */ }
    }

    const data = pageResults.map(p => {
      const base = {
        id: p.id,
        title: p.title || null,
        slug: p.slug,
        category: (!p.category || p.category.trim() === '') ? null : p.category,
        type: p.type || 'post',
        views: p.views,
        created_at: p.created_at,
        status: p.status || 'published', // 后台可以读取这个字段区分草稿
        excerpt: makeExcerpt(p.content || '', excerptLength)
      };
      // 推文专用:/tweets 页面需要展示完整正文,因此对 tweet 类型额外带回 content 字段
      if ((p.type || 'post') === 'tweet' && p.content) {
        base.content = p.content;
      }
      // 推文专用: 附上作者昵称 + 头像(单用户系统下共用同一 author)
      if ((p.type || 'post') === 'tweet') {
        base.author = author;
      }
      return base;
    });

    // ⚡ 修复 2：所有分页请求都返回 has_more
    const responseData = isPaginated
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
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
