// ============================================================
//  POST /api/user/update   鉴权：修改用户名 / 昵称 / 密码（任选）
//  当前系统为单用户。Token = password_hash；
//  改密码后服务器会回传 newToken，前端须更新 localStorage。
// ============================================================

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  // 修复：与 push.js / update.js / settings.js / user.js 保持一致，正则清洗不区分大小写 + 容忍多空格
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

    // 密码
    if (body.password !== undefined && body.password !== null && body.password !== "") {
      const p = String(body.password);
      // 不做任何长度/复杂度限制，由用户自负其责

      // ⚡ 修复 11：后端强制二次确认，curl 直接调用也无法绕过
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
