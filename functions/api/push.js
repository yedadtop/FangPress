export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. 安全校验：Token 认证
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || authHeader !== `Bearer ${env.API_TOKEN}`) {
    return new Response(JSON.stringify({ error: "Unauthorized: Token 错误或缺失" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const { title, slug, content } = await request.json();
    
    // 2. 数据非空校验
    if (!title || !slug || !content) {
      return new Response(JSON.stringify({ error: "标题(title)、别名(slug)和内容(content)不能为空" }), { 
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. 打包数据存入 KV
    const postData = {
      title: title.trim(),
      content: content.trim(),
      timestamp: new Date().toISOString()
    };

    // 以 post:为前缀，方便后面的 list.js 接口扫描
    await env.MY_KV.put(`post:${slug}`, JSON.stringify(postData));

    return new Response(JSON.stringify({ success: true, message: "文章推送成功！" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}