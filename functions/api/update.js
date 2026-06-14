// functions/api/update.js
const POST_CACHE_TTL = 604800;
import { extractR2Keys, deleteR2Images } from '../lib/r2-images.js';

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
    // ⚡ 引入 status 变量解析；type 仅在「保留原 type」时使用（避免互转带来的 slug 灾难）
    const { id, title, slug, content, category, status, type } = await request.json();

    if (!id || !slug || !content) {
      return new Response(JSON.stringify({ success: false, error: "id / 路径 / 正文不能为空" }), { status: 400 });
    }

    const newSlug = slug.trim().toLowerCase();
    const targetCategory = category ? (category.trim() || null) : null;
    // 规范化状态值，默认发布
    const targetStatus = (status && status.trim() === 'draft') ? 'draft' : 'published';

    // ⚡ 拉取旧记录以便做 type 一致性兜底（保持原 type，不允许编辑时改 type）
    // 同步拉取旧 content，用于编辑后清理被移除的 R2 图片
    const oldPost = await env.DB.prepare("SELECT slug, type, created_at, content FROM posts WHERE id = ?").bind(id).first();
    if (!oldPost) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // ⚡ 推文允许 title 为空；文章必须有 title
    const trimmedTitle = title ? String(title).trim() : '';
    if (oldPost.type === 'post' && !trimmedTitle) {
      return new Response(JSON.stringify({ success: false, error: "文章必须填写标题" }), { status: 400 });
    }

    // ⚡ 客户端若显式传 type 且与数据库原 type 不一致 → 拒绝（避免互转）
    if (type && String(type).trim() !== '' && String(type).trim() !== oldPost.type) {
      return new Response(JSON.stringify({ success: false, error: "不支持在编辑时修改内容类型" }), { status: 400 });
    }

    const now = new Date().toISOString();

    // 💡 进阶:用 RETURNING 一次性拿到 id/status/views/created_at,让 get.js 关键路径完全脱离 D1
    const updated = await env.DB
      .prepare(
        `UPDATE posts
         SET title = ?, slug = ?, content = ?, category = ?, status = ?, updated_at = ?
         WHERE id = ?
         RETURNING id, status, views, created_at, type`
      )
      .bind(trimmedTitle || null, newSlug, content.trim(), targetCategory, targetStatus, now, id)
      .first();

    if (!updated) {
      return new Response(JSON.stringify({ success: false, error: "未找到该文章，可能已被删除" }), { status: 404 });
    }

    // ⚡ 强力清除可能影响的旧缓存，防止改名/改状态后的幽灵脏数据
    if (oldPost && oldPost.slug) {
      try { await env.KV.delete(`post:content:${oldPost.slug.trim().toLowerCase()}`); } catch (_) {}
    }
    try { await env.KV.delete(`post:content:${newSlug}`); } catch (_) {}

    // ⚡ 批量清除所有 type 维度的列表缓存
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:type:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 推文 v2 缓存键（带 author 字段）也要清掉
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:v2:type:tweet:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // 兼容清理：旧版不带 type 前缀的缓存键
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:page:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
      let c2 = undefined, done2 = false;
      while (!done2) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:cat:", cursor: c2 });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        done2 = listKeys.list_complete; c2 = listKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 核心修改：只有状态依旧是 published 的文章才允许主动回填 KV；
    // 如果是 draft，上面已经全面 delete 干净了，这就完美了！
    if (targetStatus === 'published') {
      const updatedCache = {
        id: updated.id,
        status: updated.status,
        views: updated.views,
        title: trimmedTitle || null,
        content: content.trim(),
        category: targetCategory,
        type: updated.type || oldPost.type,
        created_at: updated.created_at
      };
      try {
        await env.KV.put(`post:content:${newSlug}`, JSON.stringify(updatedCache), { expirationTtl: POST_CACHE_TTL });
      } catch (e) {
        console.error('KV put failed (update.js):', e);
      }
    }

    // ⚡ 清理被移除的 R2 图片：取新旧内容的 R2 key 差集（即旧文中有但新文中没有的）
    // 失败不影响主流程
    let r2Ok = 0, r2Fail = 0, r2Keys = 0;
    try {
      const oldKeys = new Set(extractR2Keys(oldPost && oldPost.content, env));
      const newKeys = new Set(extractR2Keys(content, env));
      const orphaned = [...oldKeys].filter(k => !newKeys.has(k));
      if (orphaned.length > 0) {
        r2Keys = orphaned.length;
        const res = await deleteR2Images(env, orphaned);
        r2Ok = res.ok; r2Fail = res.fail;
      }
    } catch (e) {
      console.warn('R2 cleanup failed (update.js):', e);
    }

    return new Response(JSON.stringify({
      success: true,
      message: "文章已更新",
      r2_cleanup: { keys: r2Keys, ok: r2Ok, fail: r2Fail }
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "Slug 已被其他文章占用" }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
