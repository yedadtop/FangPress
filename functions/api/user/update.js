// ============================================================
//  POST /api/user/update   鉴权：修改用户名 / 昵称 / 密码 / 头像（任选）
//  当前系统为单用户。Token = password_hash；
//  改密码后服务器会回传 newToken，前端须更新 localStorage。
//  头像仅接受「直链 URL」（http / https），留空 / 传 null 表示清空；
//  写入 D1 后会回写 KV 缓存 site:user:profile:data，便于前端 / SSR 零成本读取。
// ============================================================

// 与 user.js / settings.js / nav-render.js 保持完全一致的缓存键
const KV_USER_KEY = "site:user:profile:data";
// 头像直链最长 2048，够覆盖绝大多数图床；超过此长度一律拒绝写入
const AVATAR_MAX_LEN = 2048;

function normalizeAvatar(input) {
  // null / undefined / "" / 全空白 → 清空（写 null）
  if (input === null || input === undefined) return { ok: true, value: null };
  const raw = String(input).trim();
  if (raw === "") return { ok: true, value: null };

  if (raw.length > AVATAR_MAX_LEN) {
    return { ok: false, error: `头像链接过长（>${AVATAR_MAX_LEN} 字符）` };
  }

  // ⚡ 仅接受 http(s) 直链；不允许 javascript: / data: / file: 等
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return { ok: false, error: "头像必须是合法的 http(s) 直链 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "头像仅支持 http:// 或 https:// 直链" };
  }
  if (!url.hostname) {
    return { ok: false, error: "头像链接缺少主机名" };
  }
  return { ok: true, value: url.toString() };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // 与 push.js / update.js / settings.js / user.js 保持一致：正则清洗不区分大小写 + 容忍多空格
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();

  const apiToken = env.API_TOKEN;
  if (apiToken && clientToken === apiToken) {
    return new Response(JSON.stringify({ success: false, error: "API_TOKEN 无法用于修改账户信息，请使用账号密码登录后操作" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 定位当前用户
  const current = await env.DB
    .prepare("SELECT id, password_hash FROM users WHERE password_hash = ?")
    .bind(clientToken)
    .first();

  if (!current) {
    return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await request.json() || {};
    const sets = [];
    const params = [];
    let newToken = null;

    // 用户名
    if (body.username !== undefined) {
      const u = String(body.username).trim();
      if (!u) {
        return new Response(JSON.stringify({ success: false, error: "用户名不能为空" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      sets.push("username = ?");
      params.push(u);
    }

    // 昵称（允许清空）
    if (body.nickname !== undefined) {
      const n = body.nickname === null ? null : String(body.nickname).trim();
      sets.push("nickname = ?");
      params.push(n || null);
    }

    // 头像（仅接受直链 URL；null / 空串表示清空）
    if (body.avatar !== undefined) {
      const av = normalizeAvatar(body.avatar);
      if (!av.ok) {
        return new Response(JSON.stringify({ success: false, error: av.error }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      sets.push("avatar = ?");
      params.push(av.value);
    }

    // 密码
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      const p = String(body.password);
      // 不做任何长度/复杂度限制，由用户自负其责

      // 后端强制二次确认，curl 直接调用也无法绕过
      if (body.passwordConfirm === undefined || body.passwordConfirm === null || body.passwordConfirm === "") {
        return new Response(JSON.stringify({ success: false, error: "改密时必须传 passwordConfirm 字段进行二次确认" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }
      if (String(body.passwordConfirm) !== p) {
        return new Response(JSON.stringify({ success: false, error: "两次输入的密码不一致" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        });
      }

      const msgBuffer = new TextEncoder().encode(p);
      const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const newHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

      sets.push("password_hash = ?");
      params.push(newHash);
      newToken = newHash;
    }

    if (sets.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "没有任何修改" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }

    params.push(current.id);
    const sql = `UPDATE users SET ${sets.join(", ")} WHERE id = ?`;
    const result = await env.DB.prepare(sql).bind(...params).run();

    if (!result.success) {
      return new Response(JSON.stringify({ success: false, error: "更新失败" }), {
        status: 500, headers: { "Content-Type": "application/json" }
      });
    }

    // ⚡ 与 settings.js 对齐：写完 D1 后立即「查出最新整行」并覆盖 KV
    // 关键点：把 password_hash 一并写入，由 GET /api/user 的 token 过滤逻辑把控安全
    try {
      const fresh = await env.DB
        .prepare("SELECT id, username, nickname, avatar, password_hash, created_at FROM users WHERE id = ?")
        .bind(current.id)
        .first();
      if (fresh) {
        // 若刚刚改了密，DB 里的 password_hash 已经是 newHash；KV 直接覆盖
        await env.KV.put(KV_USER_KEY, JSON.stringify({ success: true, data: fresh }));
      }
    } catch (e) {
      console.error('[user/update] KV 写回失败:', e);
    }

    const responseBody = { success: true, message: "账户信息已更新" };
    if (newToken) responseBody.newToken = newToken;
    return new Response(JSON.stringify(responseBody), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    if (err.message && err.message.includes("UNIQUE constraint failed")) {
      return new Response(JSON.stringify({ success: false, error: "该用户名已被占用" }), {
        status: 400, headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }
}
