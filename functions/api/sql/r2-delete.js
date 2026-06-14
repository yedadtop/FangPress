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
    // ⚡ 修复：原来用 key.includes("..") 太宽，会把含 .. 的合法 key（如 v1.0...backup.png）
    // 一起拒掉。改成按路径段检查，命中真正的路径遍历才报错。
    if (key.split("/").some(seg => seg === "..") || key.startsWith("/") || /[\x00-\x1f]/.test(key)) {
        return new Response(JSON.stringify({ success: false, error: "非法的 key" }), {
            status: 400, headers: { "Content-Type": "application/json" }
        });
    }

    try {
        // ⚡ 修复：先 head() 探测 key 是否存在，让 deleted 字段如实反映"是否真的删了一条"。
        // R2.delete() 对不存在的 key 是 no-op（不会报错），但响应里原本永远返回 deleted: 1。
        const head = await env.R2_BUCKET.head(key);
        await env.R2_BUCKET.delete(key);
        return new Response(JSON.stringify({
            success: true,
            deleted: head ? 1 : 0,
            key
        }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500, headers: { "Content-Type": "application/json" }
        });
    }
}
