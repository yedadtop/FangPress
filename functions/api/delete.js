// functions/api/delete.js
import { cleanupR2ImagesFromContent } from '../lib/r2-images.js';

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
    // ⚡ 支持单删（id）与批量（ids）。两者皆给时以 ids 为准。
    const body = await request.json();
    let idList = [];
    if (Array.isArray(body.ids)) {
      idList = body.ids.map(v => Number(v)).filter(n => Number.isFinite(n) && n > 0);
    } else if (body.id != null) {
      const n = Number(body.id);
      if (Number.isFinite(n) && n > 0) idList = [n];
    }

    if (idList.length === 0) {
      return new Response(JSON.stringify({ success: false, error: "缺少文章 id" }), { status: 400 });
    }

    // 1) 先从 D1 拿到所有待删文章的 slug 与 content，用于清理 KV 与 R2
    //    slug 为 null 的推文跳过 KV；content 用于 R2 图片清理
    const placeholders = idList.map(() => "?").join(",");
    const posts = await env.DB
      .prepare(`SELECT slug, content FROM posts WHERE id IN (${placeholders})`)
      .bind(...idList)
      .all();

    // ⚡ 修复：先做 D1 物理删除，确认有命中再清缓存；之前无论是否真的删了，
    //   都会先扫遍 KV 删一堆缓存，idList 全是无效 id 时属于无谓的 IO。

    // 2) 先执行 D1 的物理删除（同样用 IN，一次性搞定）
    const result = await env.DB
      .prepare(`DELETE FROM posts WHERE id IN (${placeholders})`)
      .bind(...idList)
      .run();

    const deleted = (result.meta && typeof result.meta.changes === 'number') ? result.meta.changes : 0;
    if (deleted === 0) {
      return new Response(JSON.stringify({ success: false, error: "未找到任何待删文章" }), { status: 404 });
    }

    // 3) 确认删除成功后才擦缓存
    // ⚡ 顺序安全擦除每篇文章的内容缓存
    try {
      for (const p of (posts.results || [])) {
        if (p && p.slug) {
          try { await env.KV.delete(`post:content:${String(p.slug).trim().toLowerCase()}`); } catch (_) {}
        }
      }
    } catch (_) {}

    // ⚡ 批量清除所有分页的首页列表缓存，防止漏网之鱼导致错位
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:page:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 修复 3：补清 type:* 前缀（与 push.js / update.js 对齐），避免 /api/list?type=... 命中陈旧列表
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:type:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // ⚡ 推文 v2 缓存键（带 author 字段）也要清掉
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const listKeys = await env.KV.list({ prefix: "site:posts:list:v2:type:tweet:", cursor });
        for (const k of listKeys.keys) await env.KV.delete(k.name);
        isComplete = listKeys.list_complete; cursor = listKeys.cursor;
      }
    } catch (_) {}

    // 清理分类缓存
    try {
      let isComplete = false, cursor = undefined;
      while (!isComplete) {
        const kvKeys = await env.KV.list({ prefix: "site:posts:list:cat:", cursor });
        for (const k of kvKeys.keys) await env.KV.delete(k.name);
        isComplete = kvKeys.list_complete; cursor = kvKeys.cursor;
      }
    } catch (_) {}

    // 4) 同步清理这些文章引用的 R2 图片（不抛错，R2 失败不影响主流程）
    let r2Ok = 0, r2Fail = 0, r2Keys = 0;
    try {
      for (const p of (posts.results || [])) {
        if (p && p.content) {
          const res = await cleanupR2ImagesFromContent(env, p.content);
          r2Ok += res.ok; r2Fail += res.fail; r2Keys += res.keys.length;
        }
      }
    } catch (e) {
      console.warn('R2 cleanup failed (delete.js):', e);
    }

    // 批量场景下允许部分命中（deleted < idList.length），按实际成功数量返回
    return new Response(JSON.stringify({
      success: true,
      message: `已删除 ${deleted} 篇文章`,
      deleted,
      r2_cleanup: { keys: r2Keys, ok: r2Ok, fail: r2Fail }
    }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}
