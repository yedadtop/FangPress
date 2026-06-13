// functions/api/delete.js

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
    // ⚡ 支持单删（id）与批量（ids）。两者皆给时以 ids 为准。
    const body = await request.json();
    let idList = [];
    if (Array.isArray(body.ids)) {
      idList = body.ids.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0);
    } else if (body.id != null) {
      const n = Number(body.id);
      if (Number.isFinite(n) && n > 0) idList = [n];
    }

    if (idList.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "缺少文章 id" }), { status: 400 });
    }

    // 1) 先从 D1 拿到所有待删文章的 slug 用于清理相关 KV 链条
    //    使用 IN (...) 一次性查，slug 为 null 的推文跳过 KV
    const placeholders = idList.map(() => "?").join(",");
    const posts = await env.DB
      .prepare(`SELECT slug FROM posts WHERE id IN (${placeholders})`)
      .bind(...idList)
      .all();

    // 2) ⚡ 顺序安全擦除每篇文章的内容缓存
    try {
      for (const p of (posts.results || [])) {
        if (p && p.slug) {
          try { await env.KV.delete(`post:content:${String(p.slug).trim().toLowerCase()}`); } catch (_) {}
        }
      }
    } catch (_) {}

    // ⚡ 批量清除所有分页的首页列表缓存，防止漏网之鱼导致错位
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:page:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 修复 3：补清 type:* 前缀（与 push.js / update.js 对齐），避免 /api/list?type=... 命中陈旧列表
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:type:", cursor });
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

    // 3) 最后执行 D1 的物理删除（同样用 IN，一次性搞定）
    const result = await env.DB
      .prepare(`DELETE FROM posts WHERE id IN (${placeholders})`)
      .bind(...idList)
      .run();

    const deleted = (result.meta && typeof result.meta.changes === 'number') ? result.meta.changes : 0;
    if (deleted === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到任何待删文章" }), { status: 404 });
    }

    // 批量场景下允许部分命中（deleted < idList.length），按实际成功数量返回
    return new Response(JSON.stringify({
      success: true,
      message: `已删除 ${deleted} 篇文章`,
      deleted
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
