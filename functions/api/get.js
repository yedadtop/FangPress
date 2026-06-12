// functions/api/get.js
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
    const dbMeta = await env.DB.prepare(
      "SELECT id, status, views FROM posts WHERE slug = ?"
    ).bind(normalizedSlug).first();

    if (!dbMeta) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (dbMeta.status !== 'published' && !isAdmin) {
      return new Response(JSON.stringify({ success: false, error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

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

      if (dbMeta.status === 'published') {
        const cachePayload = JSON.stringify(post);
        context.waitUntil(
          env.KV.put(kvKey, cachePayload, { expirationTtl: 604800 })
            .catch(err => console.error('KV put failed (get.js):', err))
        );
      }
    }

    // ⚡ 性能微调优化点：前台浏览数自增改为纯异步执行，不再阻塞当前的 HTTP 请求返回响应
    if (dbMeta.status === 'published') {
      context.waitUntil(
        env.DB.prepare("UPDATE posts SET views = views + 1 WHERE id = ?").bind(dbMeta.id).run()
          .catch(err => console.error('Async views increment failed:', err))
      );
      // 内存实时递增 1 补偿反馈给用户，响应体验提升显著
      post.views = dbMeta.views + 1;
    } else {
      post.views = dbMeta.views;
    }

    return new Response(JSON.stringify({ success: true, data: post }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': dbMeta.status === 'published' ? 'public, max-age=5' : 'no-store'
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}