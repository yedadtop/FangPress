// functions/api/sql/r2-delete.js
// POST /api/sql/r2-delete   body: { key: "2026/06/xxx.png" }
// 鉴权：Bearer Token（API_TOKEN 或 users.password_hash）
// 从 R2 存储桶中删除指定对象。不依赖 D1 表；KV 不参与。

export async function onRequestPost(context) {
    const { request, env } = context;

    // 鉴权
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
        return new Response(JSON.stringify({ success: false, error: "未授权" }), {
            status: 401, headers: { "Content-Type": "application/json" }
        });
    }
    const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const apiToken = env.API_TOKEN;
    if (!apiToken || clientToken !== apiToken) {
        const { count } = await env.DB
            .prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?")
            .bind(clientToken)
            .first();
        if (count === 0) {
            return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
                status: 401, headers: { "Content-Type": "application/json" }
            });
        }
    }

    if (!env.R2_BUCKET) {
        return new Response(JSON.stringify({ success: false, error: "R2_BUCKET 未绑定" }), {
            status: 500, headers: { "Content-Type": "application/json" }
        });
    }

    let body;
    try {
        body = await request.json();
    } catch (_) {
        return new Response(JSON.stringify({ success: false, error: "请求体不是合法 JSON" }), {
            status: 400, headers: { "Content-Type": "application/json" }
        });
    }

    const key = (body && typeof body.key === "string") ? body.key.trim() : "";
    if (!key) {
        return new Response(JSON.stringify({ success: false, error: "缺少 key 参数" }), {
            status: 400, headers: { "Content-Type": "application/json" }
        });
    }
    // 防御性检查：禁止 ../、绝对路径、控制字符
    if (key.includes("..") || key.startsWith("/") || /[\x00-\x1f]/.test(key)) {
        return new Response(JSON.stringify({ success: false, error: "非法的 key" }), {
            status: 400, headers: { "Content-Type": "application/json" }
        });
    }

    try {
        // R2.delete() 对不存在的 key 是 no-op（不会报错）
        await env.R2_BUCKET.delete(key);
        return new Response(JSON.stringify({ success: true, deleted: 1, key }), {
            headers: { "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500, headers: { "Content-Type": "application/json" }
        });
    }
}
