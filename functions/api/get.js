// functions/api/get.js
// ⚡ 大字段（title/content/category/created_at）走 KV 缓存加速；
//    views 是高频变化数据，不进 KV，每次都从 D1 实时取，保证详情页与列表页数字一致。
//    仅 published 文章写入 KV 缓存，草稿不进 KV，避免草稿内容流入边缘。
//    草稿对前台访客 404；带正确 Bearer Token 的管理员可以预览，且不污染浏览量。
//
// ⚡ 关键修正：旧版用 status='published' 写在 UPDATE 的 WHERE 里，把
//    "这篇文章存不存在"和"这篇该不该 +1 views"绑死成同一件事 → 草稿永远 404，
//    管理员即使带上 Token 也无法在后台预览 / 重新发布前校验内容。
//    现在拆成三步：
//      ① 先按 slug 查 D1 拿 status + id + views
//      ② 根据 status + 是否管理员 决定可见性
//      ③ 只对 published 文章自增 views + 回填 KV
//    顺便给"草稿 → 已发布"流程留出预览旁路。

async function isAuthorizedAdmin(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return false;
  const clientToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!clientToken) return false;

  if (env.API_TOKEN && clientToken === env.API_TOKEN) return true;

  try {
    const row = await env.DB.prepare(
      "SELECT 1 as one FROM users WHERE password_hash = ? LIMIT 1"
    ).bind(clientToken).first();
    return !!row;
  } catch (_) {
    return false;
  }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');

  if (!slug) {
    return new Response(JSON.stringify({ success: false, error: 'Missing slug parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const normalizedSlug = slug.trim().toLowerCase();
  const kvKey = `post:content:${normalizedSlug}`;
  const isAdmin = await isAuthorizedAdmin(request, env);

  try {
    // 1) 先按 slug 查 D1 拿 status + id + views（不限 status，因为草稿也得能被管理员预览）
    const dbMeta = await env.DB.prepare(
      "SELECT id, status, views FROM posts WHERE slug = ?"
    ).bind(normalizedSlug).first();

    if (!dbMeta) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 2) 草稿保护：未发布文章对前台访客 404；带正确 Bearer Token 的管理员可以预览
    if (dbMeta.status !== 'published' && !isAdmin) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 3) 拉大字段：KV 命中直接拼装；未命中回源 D1
    const cached = await env.KV.get(kvKey);
    let post;

    if (cached) {
      const c = JSON.parse(cached);
      post = {
        title: c.title,
        content: c.content,
        category: c.category ?? null,
        created_at: c.created_at
      };
    } else {
      const dbPost = await env.DB.prepare(
        "SELECT title, content, category, created_at FROM posts WHERE id = ?"
      ).bind(dbMeta.id).first();

      if (!dbPost) {
        return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const category = (!dbPost.category || dbPost.category.trim() === '') ? null : dbPost.category;
      post = {
        title: dbPost.title,
        content: dbPost.content,
        category,
        created_at: dbPost.created_at
      };

      // ⚡ 只对 published 文章回填 KV，避免草稿内容污染边缘缓存
      if (dbMeta.status === 'published') {
        const cachePayload = JSON.stringify(post);
        context.waitUntil(
          env.KV.put(kvKey, cachePayload, { expirationTtl: 604800 })
            .catch(err => console.error('KV put failed (get.js):', err))
        );
      }
    }

    // 4) views 处理：只有 published 状态才自增（草稿预览不污染计数）
    if (dbMeta.status === 'published') {
      const incResult = await env.DB.prepare(
        "UPDATE posts SET views = views + 1 WHERE id = ? RETURNING views"
      ).bind(dbMeta.id).first();
      post.views = incResult ? incResult.views : dbMeta.views;
    } else {
      post.views = dbMeta.views;
    }

    return new Response(JSON.stringify({ success: true, data: post }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // 草稿预览禁用浏览器/CDN 缓存，避免被中间层错误复用
        'Cache-Control': dbMeta.status === 'published' ? 'public, max-age=5' : 'no-store'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
