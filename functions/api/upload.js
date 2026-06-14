// functions/api/upload.js
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export async function onRequestPost(context) {
  const { request, env } = context;

  // ⚡ 1) 双重鉴权：API_TOKEN 优先，否则查 D1 users 表
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ success: false, error: "未授权" }), { status: 401 });
  }
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiToken = env.API_TOKEN;
  if (!(apiToken && clientToken === apiToken)) {
    const row = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
    if (!row || row.count === 0) {
      return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), { status: 401 });
    }
  }

  try {
    // ⚡ 2) 解析 multipart/form-data
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || typeof file === "string") {
      return new Response(JSON.stringify({ success: false, error: "未找到上传文件" }), { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return new Response(JSON.stringify({ success: false, error: "文件大小不能超过 5MB" }), { status: 400 });
    }

    // ⚡ 3) 生成唯一路径：YYYY/MM/时间戳-4位随机字符.后缀
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 6);
    const originalName = file.name || "";
    const dotIndex = originalName.lastIndexOf(".");
    const ext = dotIndex >= 0 ? originalName.slice(dotIndex + 1).toLowerCase() : "png";
    const key = `${year}/${month}/${timestamp}-${rand}.${ext}`;

    // ⚡ 4) 上传到 R2
    await env.R2_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

    // ⚡ 5) 拼接外链地址
    const baseUrl = (env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
    const fullUrl = `${baseUrl}/${key}`;

    return new Response(JSON.stringify({
      success: true,
      url: fullUrl,
      message: "上传成功"
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message || "上传失败" }), { status: 500 });
  }
}
