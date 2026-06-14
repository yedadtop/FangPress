// functions/api/sql/r2-list.js
// GET /api/sql/r2-list?q=<prefix>
// 鉴权：Bearer Token（API_TOKEN 或 users.password_hash）
// 列出 R2 存储桶中的全部对象（q 为可选 prefix，精确到子目录）。
// 不依赖 D1 表；KV 不参与。

const LIST_PAGE = 1000; // R2 单次 list() 上限

export async function onRequestGet(context) {
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

    const url = new URL(request.url);
    const prefix = url.searchParams.get("q") || "";

    try {
        // 循环翻页，把 prefix 命中的对象全部拉完
        const all = [];
        let cursor;
        do {
            const opts = { limit: LIST_PAGE };
            if (prefix) opts.prefix = prefix;
            if (cursor) opts.cursor = cursor;
            const page = await env.R2_BUCKET.list(opts);
            all.push(...(page.objects || []));
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);

        // 给前端拼出可访问的 URL（依赖环境变量 R2_PUBLIC_URL）
        const base = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

        const files = all.map(o => ({
            key: o.key,
            size: typeof o.size === "number" ? o.size : 0,
            uploaded: o.uploaded,                                  // Date，前端会 toISOString
            httpMetadata: o.httpMetadata || null,                   // 包含 contentType
            content_type: (o.httpMetadata && o.httpMetadata.contentType) || "",
            url: base ? `${base}/${o.key}` : ""
        }));

        const totalSize = files.reduce((s, f) => s + f.size, 0);

        return new Response(JSON.stringify({
            success: true,
            data: { files, totalSize }
        }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            status: 500, headers: { "Content-Type": "application/json" }
        });
    }
}
