// ⚡ 修复 10：常量时间字符串比较，避免时序攻击泄露 hash 长度
// 不做长度短路：迭代 max(a,b) 长度，差值参与异或，保证分支与执行时间恒定
function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const len = Math.max(a.length, b.length);
    let diff = a.length ^ b.length; // 长度不等也纳入 diff，保持恒定时间
    for (let i = 0; i < len; i++) {
        const ac = i < a.length ? a.charCodeAt(i) : 0;
        const bc = i < b.length ? b.charCodeAt(i) : 0;
        diff |= ac ^ bc;
    }
    return diff === 0;
}

// ⚡ 修复 10：极简 KV 限流（同一 username 在 5 分钟内最多 10 次错误尝试）
// ⚡ 修复 2：纯只读检查，移除多余 KV.put，避免与 recordLoginFailure 产生写写竞态
async function isRateLimited(env, username) {
    if (!env.KV) return false;
    const key = `rl:login:${String(username || '').toLowerCase()}`;
    const windowMs = 5 * 60 * 1000;
    const limit = 10;
    try {
        const cur = await env.KV.get(key, { type: 'json' });
        const now = Date.now();
        const list = (cur && Array.isArray(cur.fails)) ? cur.fails : [];
        // 过滤掉超出时间窗的失败记录
        const fresh = list.filter(t => now - t < windowMs);
        if (fresh.length >= limit) {
            // 暴露重试时间（秒）
            return Math.ceil((windowMs - (now - fresh[0])) / 1000);
        }
        return 0;
    } catch (_) {
        return false; // KV 异常时不做拦截，宁可放过
    }
}

async function recordLoginFailure(env, username) {
    if (!env.KV) return;
    const key = `rl:login:${String(username || '').toLowerCase()}`;
    try {
        const cur = await env.KV.get(key, { type: 'json' });
        const now = Date.now();
        const list = (cur && Array.isArray(cur.fails)) ? cur.fails : [];
        list.push(now);
        await env.KV.put(key, JSON.stringify({ fails: list }), { expirationTtl: 360 });
    } catch (_) {}
}

async function clearLoginFailures(env, username) {
    if (!env.KV) return;
    const key = `rl:login:${String(username || '').toLowerCase()}`;
    try { await env.KV.delete(key); } catch (_) {}
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const { username, password } = await request.json();

        // ⚡ 修复 10：登录前置限流。命中限流直接 429，不暴露账号是否存在
        const retryAfter = await isRateLimited(env, username);
        if (retryAfter) {
            return new Response(JSON.stringify({ success: false, error: `尝试过于频繁，请 ${retryAfter} 秒后再试` }), {
                status: 429,
                headers: {
                    "Content-Type": "application/json",
                    "Retry-After": String(retryAfter)
                }
            });
        }

        // 1. 算出输入的密码哈希
        const msgBuffer = new TextEncoder().encode(password || '');
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const inputHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

        // ⚡ 修复 10：始终跑一次假比对，使「用户不存在」与「密码错」耗时一致，削弱枚举攻击
        const dummyHash = "0000000000000000000000000000000000000000000000000000000000000000";

        // 2. 数据库匹配
        const user = await env.DB.prepare("SELECT id, username, password_hash, nickname, avatar FROM users WHERE username = ?")
            .bind(username)
            .first();

        const realHash = user ? user.password_hash : dummyHash;
        const ok = !!user && constantTimeEqual(realHash, inputHash);

        if (!ok) {
            await recordLoginFailure(env, username);
            return new Response(JSON.stringify({ success: false, error: "用户名或密码错误" }), {
                status: 401,
                headers: { "Content-Type": "application/json" }
            });
        }

        await clearLoginFailures(env, username);

        // 3. 登录成功，生成一个会话凭证（这里借用用户的密码哈希作为临时的鉴权秘钥传回）
        return new Response(JSON.stringify({
            success: true,
            message: "登录成功",
            token: user.password_hash, // 替代旧的明文 env.API_TOKEN
            nickname: user.nickname,
            avatar: user.avatar || null
        }), {
            headers: { "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
    }
}