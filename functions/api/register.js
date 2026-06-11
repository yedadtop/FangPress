export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { username, password, nickname } = await request.json();

    if (!username || !password) {
      return new Response(JSON.stringify({ success: false, error: "用户名和密码不能为空" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 1. 【核心逻辑】检查数据库中是否已有用户
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users").first();

    if (count > 0) {
      return new Response(JSON.stringify({ success: false, error: "系统已初始化，不再允许开荒注册" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. 原生 Web Crypto 算 SHA-256 密码哈希（防明文脱裤）
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const passwordHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    // 3. 写入用户表
    await env.DB.prepare(
      "INSERT INTO users (username, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)"
    )
    .bind(username.trim(), passwordHash, nickname ? nickname.trim() : username, new Date().toISOString())
    .run();

    return new Response(JSON.stringify({ success: true, message: "首席管理员注册成功，注册通道已永久关闭！" }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}