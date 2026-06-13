// functions/api/navs.js
// 站点导航管理 API
//   GET  /api/navs          公开：读取全部启用的导航（按 sort_order 升序），命中 KV 缓存
//   POST /api/navs          受保护：新建一项
//   POST /api/navs/update   受保护：编辑一项
//   POST /api/navs/delete   受保护：删除一项
//   POST /api/navs/reorder  受保护：批量调整 sort_order
// 缓存键：site:navs:list:active  (KV, JSON 字符串)
//
// ⚡ 任何写操作都会 await 重新生成 KV 缓存后返回，确保前台下次 SSR 立即生效。

import { normalizeNavRow } from "../lib/nav-render.js";
import { nowInShanghai } from "../lib/time.js";

const KV_NAVS_KEY = "site:navs:list:active";

// ===== 统一鉴权：复制现有受保护接口的契约 =====
async function authorize(request, env) {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader) return { ok: false, status: 401, error: "未授权" };
    const clientToken = authHeader.replace(/^Bearer\s+/i, "").trim();
    const apiToken = env.API_TOKEN;
    if (apiToken && clientToken === apiToken) return { ok: true };
    const { count } = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM users WHERE password_hash = ?"
    ).bind(clientToken).first();
    if (count === 0) return { ok: false, status: 401, error: "口令失效，请重新登录" };
    return { ok: true };
}

// ===== 读取一次最新数据并回填 KV =====
async function rebuildAndCacheNavs(env) {
    const { results } = await env.DB.prepare(
        `SELECT id, label, href, tab_key, open_in_new_tab, is_active, sort_order, created_at, updated_at
         FROM site_navs
         WHERE is_active = 1
         ORDER BY sort_order ASC, id ASC`
    ).all();
    const list = (results || []).map(normalizeNavRow);
    await env.KV.put(KV_NAVS_KEY, JSON.stringify({ success: true, data: list }));
    return list;
}

// ===== 读取全部（含禁用项，仅供后台） =====
async function readAllFromDB(env) {
    const { results } = await env.DB.prepare(
        `SELECT id, label, href, tab_key, open_in_new_tab, is_active, sort_order, created_at, updated_at
         FROM site_navs
         ORDER BY sort_order ASC, id ASC`
    ).all();
    return (results || []).map(normalizeNavRow);
}

// ============ GET 公开读取 ============
export async function onRequestGet(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const isAdmin = url.searchParams.get('admin') === '1';

    try {
        // 后台请求直接绕 KV 查 D1，保证看到最新禁用项
        if (isAdmin) {
            const auth = await authorize(request, env);
            if (!auth.ok) {
                return new Response(JSON.stringify({ success: false, error: auth.error }), {
                    status: auth.status, headers: { "Content-Type": "application/json" }
                });
            }
            const list = await readAllFromDB(env);
            return new Response(JSON.stringify({ success: true, data: list }), {
                headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
            });
        }

        // 公开请求：先查 KV，缺失再 D1 降级 + 回填
        const cached = await env.KV.get(KV_NAVS_KEY).catch(() => null);
        if (cached) {
            return new Response(cached, {
                headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=10, s-maxage=60" }
            });
        }

        const list = await rebuildAndCacheNavs(env);
        return new Response(JSON.stringify({ success: true, data: list }), {
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
    }
}

// ============ POST 新建 ============
export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    try {
        const auth = await authorize(request, env);
        if (!auth.ok) {
            return new Response(JSON.stringify({ success: false, error: auth.error }), {
                status: auth.status, headers: { "Content-Type": "application/json" }
            });
        }

        const body = await request.json();
        if (!body || typeof body !== "object") {
            return new Response(JSON.stringify({ success: false, error: "请求体不是有效对象" }), { status: 400 });
        }

        const now = nowInShanghai();
        let result;

        // ---- 路由：根据 ?action= 决定操作；缺省为 create（兼容）
        const action = (url.searchParams.get('action') || '').toLowerCase();

        if (action === 'update') {
            const { id, label, href, tab_key, open_in_new_tab, is_active, sort_order } = body;
            if (!id) {
                return new Response(JSON.stringify({ success: false, error: "缺少 id" }), { status: 400 });
            }
            const old = await env.DB.prepare("SELECT * FROM site_navs WHERE id = ?").bind(id).first();
            if (!old) {
                return new Response(JSON.stringify({ success: false, error: "未找到该导航项" }), { status: 404 });
            }

            const newLabel = (label !== undefined ? String(label).trim() : old.label);
            if (!newLabel) return new Response(JSON.stringify({ success: false, error: "名称不能为空" }), { status: 400 });
            const newHref = (href !== undefined ? String(href).trim() : old.href);
            if (!newHref) return new Response(JSON.stringify({ success: false, error: "链接不能为空" }), { status: 400 });

            let newTabKey = (tab_key !== undefined ? (tab_key === null || String(tab_key).trim() === '' ? null : String(tab_key).trim()) : old.tab_key);
            if (newTabKey !== null) {
                // 限定 tab_key 长度，避免脏数据
                if (newTabKey.length > 32) newTabKey = newTabKey.slice(0, 32);
            }

            const newOpen = (open_in_new_tab !== undefined ? (Number(open_in_new_tab) === 1 ? 1 : 0) : old.open_in_new_tab);
            const newActive = (is_active !== undefined ? (Number(is_active) === 1 ? 1 : 0) : old.is_active);
            const newSort = (sort_order !== undefined ? Number(sort_order) : old.sort_order);
            const finalSort = Number.isInteger(newSort) ? newSort : 0;

            result = await env.DB.prepare(
                `UPDATE site_navs
                 SET label = ?, href = ?, tab_key = ?, open_in_new_tab = ?, is_active = ?, sort_order = ?, updated_at = ?
                 WHERE id = ?`
            ).bind(newLabel, newHref, newTabKey, newOpen, newActive, finalSort, now, id).run();
        }
        else if (action === 'delete') {
            const { id } = body;
            if (!id) {
                return new Response(JSON.stringify({ success: false, error: "缺少 id" }), { status: 400 });
            }
            result = await env.DB.prepare("DELETE FROM site_navs WHERE id = ?").bind(id).run();
            if (result.meta && result.meta.changes === 0) {
                return new Response(JSON.stringify({ success: false, error: "未找到该导航项" }), { status: 404 });
            }
        }
        else if (action === 'reorder') {
            // body 形如：{ order: [3, 1, 2, 5, 4] }  —— 数组里是 id，按数组顺序赋 sort_order
            const { order } = body;
            if (!Array.isArray(order) || order.length === 0) {
                return new Response(JSON.stringify({ success: false, error: "缺少 order 数组" }), { status: 400 });
            }
            const step = 10; // 留出插入新项的空间
            const stmt = env.DB.prepare(
                `UPDATE site_navs SET sort_order = ?, updated_at = ? WHERE id = ?`
            );
            // 顺序串行执行（SQLite 在 D1 上支持批 batch，但分步更稳）
            for (let i = 0; i < order.length; i++) {
                const id = Number(order[i]);
                if (!Number.isInteger(id) || id <= 0) continue;
                await stmt.bind((i + 1) * step, now, id).run();
            }
        }
        else {
            // ---- create ----
            const { label, href, tab_key, open_in_new_tab, is_active, sort_order } = body;
            const trimmedLabel = label ? String(label).trim() : '';
            const trimmedHref  = href  ? String(href).trim()  : '';
            if (!trimmedLabel) return new Response(JSON.stringify({ success: false, error: "名称不能为空" }), { status: 400 });
            if (!trimmedHref)  return new Response(JSON.stringify({ success: false, error: "链接不能为空" }),  { status: 400 });

            let normalizedTabKey = (tab_key === null || tab_key === undefined || String(tab_key).trim() === '')
                ? null
                : String(tab_key).trim().slice(0, 32);

            const isOpen  = Number(open_in_new_tab) === 1 ? 1 : 0;
            const isOn    = (is_active === undefined ? 1 : (Number(is_active) === 1 ? 1 : 0));
            let finalSort = Number(sort_order);
            if (!Number.isInteger(finalSort)) {
                // 没传 sort_order：自动追加在末尾
                const { max_sort } = await env.DB.prepare(
                    "SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM site_navs"
                ).first();
                finalSort = (max_sort || 0) + 10;
            }

            result = await env.DB.prepare(
                `INSERT INTO site_navs (label, href, tab_key, open_in_new_tab, is_active, sort_order, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(trimmedLabel, trimmedHref, normalizedTabKey, isOpen, isOn, finalSort, now, now).run();
        }

        // 写后立刻重建缓存，确保前台下次 SSR 立即生效
        await rebuildAndCacheNavs(env);

        return new Response(JSON.stringify({ success: true, message: "导航缓存已同步" }), {
            headers: { "Content-Type": "application/json" }
        });
    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
    }
}
