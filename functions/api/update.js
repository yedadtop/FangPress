// functions/api/update.js
const POST_CACHE_TTL = 604800;

import { nowInShanghai } from "../../lib/time.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ success: false, error: "未授权" }), { status: 401 });
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiToken = env.API_TOKEN;
  if (apiToken && clientToken === apiToken) {
  } else {
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
    if (count === 0) return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), { status: 401 });
  }

  try {
    // ⚡ 引入 status 变量解析
    const { id, title, slug, content, category, status } = await request.json();

    if (!id || !title || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "id / 标题 / 路径 / 正文不能为空" }), { status: 400 });
    }

    const newSlug = slug.trim().toLowerCase();
    const targetCategory = category ? (category.trim() || null) : null;
    // 规范化状态值，默认发布
    const targetStatus = (status && status.trim() === 'draft') ? 'draft' : 'published';

    const oldPost = await env.DB.prepare("SELECT slug, category, created_at FROM posts WHERE id = ?").bind(id).first();
    // 新数据使用上海时区（+08:00），历史数据保留原 UTC 不动
    const now = nowInShanghai();

    // 💡 进阶:用 RETURNING 一次性拿到 id/status/views/created_at,让 get.js 关键路径完全脱离 D1
    const updated = await env.DB
      .prepare(
        `UPDATE posts
         SET title = ?, slug = ?, content = ?, category = ?, status = ?, updated_at = ?
         WHERE id = ?
         RETURNING id, status, views, created_at`
      )
      .bind(title.trim(), newSlug, content.trim(), targetCategory, targetStatus, now, id)
      .first();

    if (!updated) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // ⚡ 强力清除可能影响的旧缓存，防止改名/改状态后的幽灵脏数据
    if (oldPost && oldPost.slug) {
      try { await env.KV.delete(`post:content:${oldPost.slug.trim().toLowerCase()}`); } catch (_) {}
    }
    try { await env.KV.delete(`post:content:${newSlug}`); } catch (_) {}

    // ⚡ 批量清除所有分页的首页列表缓存，防止漏网之鱼导致错位
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:page:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // 清理分类缓存
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const kvKeys = await env.KV.list({ prefix: "site:posts:list:cat:", cursor });
        for (const k of kvKeys.keys) await env.KV.delete(k.name);
        isComplete = kvKeys.list_complete; cursor = kvKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 核心修改：只有状态依旧是 published 的文章才允许主动回填 KV；
    // 如果是 draft，上面已经全面 delete 干净了，这就完美了！
    if (targetStatus === 'published') {
      const updatedCache = {
        id: updated.id,
        status: updated.status,
        views: updated.views,
        title: title.trim(),
        content: content.trim(),
        category: targetCategory,
        created_at: updated.created_at
      };
      try {
        await env.KV.put(`post:content:${newSlug}`, JSON.stringify(updatedCache), { expirationTtl: POST_CACHE_TTL });
      } catch (e) {
        console.error('KV put failed (update.js):', e);
      }
    }

    return new Response(JSON.stringify({ success: true, message: "文章已更新" }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "Slug 已被其他文章占用" }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}