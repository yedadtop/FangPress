// functions/lib/nav-render.js
// 头部导航 + 站点设置 渲染共享模块：桌面端 nav + 移动端菜单 + 站点设置 D1 兜底 共用
// 数据契约：site_navs 行的标准化形态 { id, label, href, tab_key, open_in_new_tab, is_active, sort_order }

import { escapeHtml } from './list-render.js';

const KV_NAVS_KEY = 'site:navs:list:active';
const KV_SETTINGS_KEY = 'site:settings:data';

// 硬编码的兜底默认值，用于 KV 命中失败且 D1 也拿不到时（极端兜底，绝不返回空）
const FALLBACK_NAVS = [
    { id: 0, label: '文章', href: '/posts',  tab_key: 'posts',  open_in_new_tab: false, is_active: true, sort_order: 10 },
    { id: 0, label: '推文', href: '/tweets', tab_key: 'tweets', open_in_new_tab: false, is_active: true, sort_order: 20 }
];

// === V8 Isolate 内模块级缓存 ===
// 旧实现:每次 SSR 都要 2 次 KV 读(settings + navs),即便 KV 命中,仍是网络往返
// 改成:同 V8 Isolate 内 60s 内的重复请求直接吃内存,KV 调用次数下降一个量级
// 60s TTL 远低于 Cloudflare Isolate 寿命(~15min),Isolate 回收后模块状态归零,无需手动清理
// 风险:设置变更最多延迟 60s 生效(可接受,因为这些数据极少改)
const MODULE_TTL_MS = 60000;
let _navsCache = null;
let _navsCacheExpireAt = 0;
let _settingsCache = null;
let _settingsCacheExpireAt = 0;

function readCache(cache, expireAt) {
    if (cache != null && expireAt > Date.now()) return cache;
    return null;
}
function writeCache(value, ttlMs) {
    return { value, expireAt: Date.now() + ttlMs };
}

// 将 DB 行（0/1 整数）转成前端友好的标准化对象
export function normalizeNavRow(row) {
    if (!row) return null;
    return {
        id:             row.id,
        label:          row.label || '',
        href:           row.href || '',
        tab_key:        row.tab_key || null,
        open_in_new_tab: Number(row.open_in_new_tab) === 1,
        is_active:      Number(row.is_active) === 1,
        sort_order:     Number(row.sort_order || 0),
        created_at:     row.created_at || null,
        updated_at:     row.updated_at || null
    };
}

// 过滤出启用项并按 sort_order 升序
export function sortActiveNavs(list) {
    if (!Array.isArray(list)) return [];
    return list
        .filter(n => n && n.is_active)
        .slice()
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
}

// SSR 共用：KV 优先 → D1 降级并异步回填 → 硬编码兜底（绝不返回空数组）
//   - context 可选；传入后会用 context.waitUntil 回填 KV（不阻塞响应）
//   - 返回值始终是「启用项」按 sort_order 升序的数组
//   - 模块级缓存:同 V8 Isolate 60s 内的重复请求直接吃内存,跳过 KV/D1
export async function getActiveNavs(env, context) {
    // 0) 模块级缓存命中
    const cached = readCache(_navsCache, _navsCacheExpireAt);
    if (cached) return cached;

    // 1) 先读 KV
    const raw = await env.KV.get(KV_NAVS_KEY).catch(() => null);
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj && obj.success && Array.isArray(obj.data) && obj.data.length > 0) {
                const entry = writeCache(obj.data, MODULE_TTL_MS);
                _navsCache = entry.value;
                _navsCacheExpireAt = entry.expireAt;
                return _navsCache;
            }
        } catch (_) { /* 损坏就继续走 D1 */ }
    }

    // 2) KV 缺失/空：D1 兜底
    try {
        const { results } = await env.DB.prepare(
            `SELECT id, label, href, tab_key, open_in_new_tab, is_active, sort_order
             FROM site_navs
             WHERE is_active = 1
             ORDER BY sort_order ASC, id ASC`
        ).all();
        const list = (results || []).map(normalizeNavRow);

        if (list.length > 0) {
            // 回填 KV（不阻塞响应）
            const put = env.KV.put(KV_NAVS_KEY, JSON.stringify({ success: true, data: list }))
                .catch(err => console.error('[navs] KV 回填失败:', err));
            if (context && typeof context.waitUntil === 'function') {
                context.waitUntil(put);
            } else {
                await put;
            }
            const entry = writeCache(list, MODULE_TTL_MS);
            _navsCache = entry.value;
            _navsCacheExpireAt = entry.expireAt;
            return _navsCache;
        }
    } catch (err) {
        console.error('[navs] D1 降级失败:', err);
    }

    // 3) 终极兜底：硬编码默认值，绝不返回空（不缓存,避免污染 fallback 状态）
    return FALLBACK_NAVS;
}

// SSR / API 共用：读取站点设置。KV 优先 → D1 兜底并异步回填 → 空对象兜底
//   - context 可选；传入后会用 context.waitUntil 回填 KV（不阻塞响应）
//   - 返回值始终是普通对象（可能为 {}，但绝不会抛错）
//   - 模块级缓存:同 V8 Isolate 60s 内的重复请求直接吃内存,跳过 KV/D1
export async function getSettings(env, context) {
    // 0) 模块级缓存命中
    const cached = readCache(_settingsCache, _settingsCacheExpireAt);
    if (cached) return cached;

    // 1) 先读 KV
    const raw = await env.KV.get(KV_SETTINGS_KEY).catch(() => null);
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj && obj.data && typeof obj.data === 'object') {
                const entry = writeCache(obj.data, MODULE_TTL_MS);
                _settingsCache = entry.value;
                _settingsCacheExpireAt = entry.expireAt;
                return _settingsCache;
            }
        } catch (_) { /* 损坏就继续走 D1 */ }
    }

    // 2) KV 缺失/损坏：D1 兜底
    try {
        const { results } = await env.DB.prepare(
            `SELECT key, value FROM site_settings`
        ).all();
        const data = {};
        (results || []).forEach(row => { data[row.key] = row.value; });

        // 回填 KV（不阻塞响应）
        const payload = JSON.stringify({ success: true, data });
        const put = env.KV.put(KV_SETTINGS_KEY, payload).catch(err => console.error('[settings] KV 回填失败:', err));
        if (context && typeof context.waitUntil === 'function') {
            context.waitUntil(put);
        } else {
            await put;
        }
        const entry = writeCache(data, MODULE_TTL_MS);
        _settingsCache = entry.value;
        _settingsCacheExpireAt = entry.expireAt;
        return _settingsCache;
    } catch (err) {
        console.error('[settings] D1 降级失败:', err);
    }

    // 3) 终极兜底（不缓存,避免返回空对象污染状态）
    return {};
}

// 渲染桌面端 <nav> 内的 <a> 列表
// 用于 HTMLRewriter 注入到 <div id="ssr-header-nav"> 容器的 innerHTML
export function renderHeaderNav(navs) {
    if (!Array.isArray(navs) || navs.length === 0) return '';
    return navs.map(n => {
        const href    = escapeHtml(n.href || '#');
        const label   = escapeHtml(n.label || '');
        const tabAttr = n.tab_key ? ` data-tab="${escapeHtml(n.tab_key)}"` : '';
        const target  = n.open_in_new_tab ? ' target="_blank" rel="noopener noreferrer"' : '';
        const cls     = 'tab-link text-stone-500 hover:text-stone-900 transition-colors';
        return `<a href="${href}" class="${cls}"${tabAttr}${target}>${label}</a>`;
    }).join('');
}

// 渲染移动端菜单内的 <a> 列表
// 第一个不加分隔线，其余都加 border-t
export function renderMobileMenu(navs) {
    if (!Array.isArray(navs) || navs.length === 0) return '';
    return navs.map((n, i) => {
        const href    = escapeHtml(n.href || '#');
        const label   = escapeHtml(n.label || '');
        const tabAttr = n.tab_key ? ` data-tab="${escapeHtml(n.tab_key)}"` : '';
        const target  = n.open_in_new_tab ? ' target="_blank" rel="noopener noreferrer"' : '';
        const sep     = i === 0 ? '' : ' border-t border-stone-200/60';
        const cls     = 'mobile-menu-link block px-4 py-2.5 text-stone-600 hover:bg-stone-100/60 hover:text-stone-900 transition-colors' + sep;
        return `<a href="${href}" class="${cls}"${tabAttr}${target}>${label}</a>`;
    }).join('');
}
