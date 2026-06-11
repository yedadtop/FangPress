export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { username, password } = await request.json();

    // 1. 算出输入的密码哈希
    const msgBuffer = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const inputHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

    // 2. 数据库匹配
    const user = await env.DB.prepare("SELECT id, username, password_hash, nickname FROM users WHERE username = ?")
      .bind(username)
      .first();

    if (!user || user.password_hash !== inputHash) {
      return new Response(JSON.stringify({ success: false, error: "用户名或密码错误" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 3. 登录成功，生成一个会话凭证（这里借用用户的密码哈希作为临时的鉴权秘钥传回）
    return new Response(JSON.stringify({
      success: true,
      message: "登录成功",
      token: user.password_hash, // 替代旧的明文 env.API_TOKEN
      nickname: user.nickname
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}