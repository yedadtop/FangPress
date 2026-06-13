// functions/api/push.js
const KV_LIST_KEY_PREFIX = "site:posts:list:type:"; // 缓存键前缀：按 type 隔离
const POST_CACHE_TTL = 604800;

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
    const { title, slug, content, category, type } = await request.json();

    // ⚡ 1) 业务校验：content 必填；title 在推文场景下可空
    if (!content || !String(content).trim()) {
      return new Response(JSON.stringify({ success: false, error: "正文不能为空" }), { status: 400 });
    }

    // ⚡ 2) 规范化 type；非法值兜底为 post
    const normalizedType = (type && String(type).trim().toLowerCase() === 'tweet') ? 'tweet' : 'post';

    // ⚡ 3) 文章必须有 title；推文 title 可空
    const trimmedTitle = title ? String(title).trim() : '';
    if (normalizedType === 'post' && !trimmedTitle) {
      return new Response(JSON.stringify({ success: false, error: "文章必须填写标题" }), { status: 400 });
    }
    if (normalizedType === 'tweet' && !trimmedTitle) {
      // 推文无标题：保持 null 写入
    }

    // ⚡ 4) 推文 slug 缺失时自动按时间戳生成，确保 UNIQUE 不冲突
    let formattedSlug = slug ? String(slug).trim().toLowerCase() : '';
    if (normalizedType === 'tweet' && !formattedSlug) {
      const stamp = Date.now().toString(36); // 36 进制更短
      const rand = Math.random().toString(36).slice(2, 6);
      formattedSlug = `t-${stamp}-${rand}`;
    } else if (!formattedSlug) {
      return new Response(JSON.stringify({ success: false, error: "Slug 必填" }), { status: 400 });
    }

    const targetCategory = category ? (String(category).trim() || null) : null;
    const currentTime = new Date().toISOString();

    // 💡 进阶：使用 RETURNING 一次性拿到 id/status/views,让 get.js 的关键路径完全脱离 D1
    const inserted = await env.DB.prepare(
      `INSERT INTO posts (title, slug, content, category, type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING id, status, views, created_at`
    )
    .bind(
      trimmedTitle || null,
      formattedSlug,
      String(content).trim(),
      targetCategory,
      normalizedType,
      currentTime,
      currentTime
    )
    .first();

    const newPostCache = {
      id: inserted.id,
      status: inserted.status,
      views: inserted.views,
      title: trimmedTitle || null,
      content: String(content).trim(),
      category: targetCategory,
      type: normalizedType,
      created_at: inserted.created_at
    };

    try {
      await env.KV.put(`post:content:${formattedSlug}`, JSON.stringify(newPostCache), { expirationTtl: POST_CACHE_TTL });
    } catch (e) {
      console.error('KV put failed (push.js):', e);
    }

    // ⚡ 批量清除所有 type 维度的列表缓存（post + tweet + 不分 type 的旧键）
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: KV_LIST_KEY_PREFIX, cursor });
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

    return new Response(JSON.stringify({ success: true, message: "Post saved to D1 successfully" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "The slug already exists" }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
