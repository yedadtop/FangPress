// functions/api/settings.js
const ALLOWED_KEYS = new Set(["site_title", "site_subtitle", "show_views", "excerpt_length", "home_mode"]);
const ALLOWED_HOME_MODES = new Set(["mix", "posts", "tweets"]);
const KV_SETTINGS_KEY = "site:settings:data";

import { nowInShanghai } from "../lib/time.js";

export async function onRequestGet(context) {
  // ... 保持原有代码不变 ...
  const { env } = context;
  try {
    const cachedSettings = await env.KV.get(KV_SETTINGS_KEY).catch(() => null);
    if (cachedSettings) {
      return new Response(cachedSettings, {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10, s-maxage=60" }
      });
    }

    const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const data = {};
    (results || []).forEach(row => { data[row.key] = row.value; });

    const responseData = { success: true, data };
    const responseString = JSON.stringify(responseData);

    context.waitUntil(env.KV.put(KV_SETTINGS_KEY, responseString));

    return new Response(responseString, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch (err) { 
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); 
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return new Response(JSON.stringify({ success: false, error: "未授权" }), { status: 401 });
  const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiToken = env.API_TOKEN;
  if (apiToken && clientToken === apiToken) {
  } else {
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM users WHERE password_hash = ?").bind(clientToken).first();
    if (count === 0) return new Response(JSON.stringify({ success: false, error: "口令失效，请重新登录" }), { status: 401 });
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== "object") return new Response(JSON.stringify({ success: false, error: "请求体不是有效对象" }), { status: 400 });

    // 新数据使用上海时区（+08:00），历史数据保留原 UTC 不动
    const now = nowInShanghai();
    const upsert = env.DB.prepare(
      `INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    );

    let touched = 0;
    for (const [key, value] of Object.entries(body)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      let strValue = String(value ?? "").trim();
      if (strValue === "") continue;
      
      if (key === "show_views") {
        if (!["0", "1"].includes(strValue)) continue;
      } else if (key === "excerpt_length") {
        const n = parseInt(strValue, 10);
        if (!Number.isInteger(n) || n < 0 || n > 1000) continue;
        strValue = String(n);
      } else if (key === "home_mode") {
        if (!ALLOWED_HOME_MODES.has(strValue)) continue;
      }
      await upsert.bind(key, strValue, now).run();
      touched++;
    }

    // ⚡ 修复 1：删除 await env.KV.delete(KV_SETTINGS_KEY); 杜绝 SSR 白屏窗口期

    // 清理分页和分类缓存
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:page:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const kvKeys = await env.KV.list({ prefix: "site:posts:list:cat:", cursor });
        for (const k of kvKeys.keys) await env.KV.delete(k.name);
        isComplete = kvKeys.list_complete; cursor = kvKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 修复 1：直接查出新数据，通过 overwrite 覆盖旧的 settings 缓存
    const { results: freshSettings } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
    const freshData = {};
    (freshSettings || []).forEach(row => { freshData[row.key] = row.value; });
    
    // 使用 await 确保在响应前 KV 已经更新完毕，彻底抹除不同步
    await env.KV.put(KV_SETTINGS_KEY, JSON.stringify({ success: true, data: freshData }));

    return new Response(JSON.stringify({ success: true, message: `已更新 ${touched} 项配置并联动清空全站缓存。` }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}