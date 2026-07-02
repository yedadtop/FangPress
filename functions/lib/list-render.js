// functions/lib/list-render.js
// 列表渲染共享模块：主页 / posts 列表 / tweets 列表 共用

export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// === Intl.DateTimeFormat 单例 ===
// 列表页每页 10 条推文,旧实现每次 formatDate 都 new Intl.DateTimeFormat,
// V8 下每次构造 50-200μs,累计 1-2ms CPU/请求。改为模块级懒单例,
// 整个 V8 Isolate 生命周期内只构造一次,后续请求零成本。
// try/catch 兜底:如果 Intl 不可用,回退到无格式化(空字符串),与原行为一致。
let _shortDateFormatter = null;
let _longDateFormatter  = null;
function getShortDateFormatter() {
    if (!_shortDateFormatter) {
        _shortDateFormatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            month: 'numeric', day: 'numeric'
        });
    }
    return _shortDateFormatter;
}
function getLongDateFormatter() {
    if (!_longDateFormatter) {
        _longDateFormatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: false
        });
    }
    return _longDateFormatter;
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    try {
        // ⚡️ 主页风格:仅显示月-日(如 "6-14"),去年份 + dash 分隔,更紧凑
        const parts = getShortDateFormatter().formatToParts(d);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        const m   = (map.month || '').replace(/[^0-9]/g, '');
        const day = (map.day   || '').replace(/[^0-9]/g, '');
        return `${parseInt(m, 10)}-${parseInt(day, 10)}`;
    } catch (_) {
        return '';
    }
}

// 详情页风格:年-月-日 时:分(如 "2026-6-14 13:47"),无前导零,dash 分隔
// 与 formatDate 共享 Intl 单例机制;原 post/[slug].js / tweet/[slug].js 内联
// 实现完全等价,集中到这里便于单点维护 + 单例复用。
export function formatDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    try {
        const parts = getLongDateFormatter().formatToParts(d);
        const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
        const m   = (map.month  || '').replace(/[^0-9]/g, '');
        const day = (map.day    || '').replace(/[^0-9]/g, '');
        const h   = (map.hour   || '').replace(/[^0-9]/g, '');
        const min = (map.minute || '').replace(/[^0-9]/g, '');
        return `${map.year}-${parseInt(m, 10)}-${parseInt(day, 10)} ${parseInt(h, 10)}:${parseInt(min, 10)}`;
    } catch (_) {
        return '';
    }
}

export function renderViewsIcon(views) {
    return `
        <span class="flex items-center gap-1 font-sans">
            <svg class="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            ${views || 0}
        </span>
        <span>·</span>
    `;
}

export function safeParseKV(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

// 把已经 escapeHtml 过的 HTML 字符串里的 ![alt](url) 还原为 <img class="tweet-img">
// 设计前提:
//   1) 调用方先 escapeHtml(raw),再调用本函数;escapeHtml 不会破坏 ![alt](url) 中
//      的 [, ], (, ), !, :, /, 字母数字等字符,alt 与 url 内的 & < > " ' 已被安全转义
//   2) 正则限定 url 仅匹配 http(s):// 与 data:image/,杜绝 javascript: 等 XSS scheme
//   3) url 内的 & 已被转义为 &amp;,写入 src 属性后浏览器会自动还原,语义不变
//   4) alt 已经 escapeHtml 过,直接拼接即可,无需再转义
//   5) loading="lazy" 让多图推文只按需加载;onerror 隐藏加载失败的图,避免破图占位
const TWEET_IMG_RE = /!\[([^\]]*?)\]\((https?:\/\/[^)\s<]+|data:image\/[^)\s<]+)\)/gi;

export function renderTweetContent(escapedHtml) {
    return String(escapedHtml == null ? '' : escapedHtml).replace(
        TWEET_IMG_RE,
        function (m, alt, url) {
            return '<img class="tweet-img" src="' + url + '" alt="' + alt + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" />';
        }
    );
}

export function renderPostItem(post, i, showViews) {
    if (!post) return '';
    const slug = post.slug || '';
    const type = post.type || 'post';

    // 推文渲染(混合列表场景,如首页 mix 模式):
    //  - 桌面端采用 float 布局:日期靠右浮动,正文环绕
    //  - 移动端日期放到正文下方右对齐,与文章日期样式保持一致
    if (type === 'tweet') {
        const dateStr = formatDate(post.created_at);

        // 桌面端日期:float-right 嵌入正文容器
        const dateDesktop = dateStr
            ? `<time class="hidden md:inline float-right ml-4 mt-1 text-xs text-stone-400 tabular-nums tracking-wider font-sans whitespace-nowrap">${dateStr}</time>`
            : '';

        // 移动端日期:与文章日期共用相同的容器与字体类,放到正文下方右对齐
        const dateMobile = dateStr
            ? `<div class="md:hidden flex items-center justify-end gap-3 text-xs text-stone-400 tabular-nums tracking-wider pt-1">
                 <time class="font-sans">${dateStr}</time>
               </div>`
            : '';

        // 正文容器:桌面端 meta 浮在正文中,移动端 meta 单独放正文下方
        // ⚡️ 图片 markdown 通过 renderTweetContent 在转义后的 HTML 上还原为 <img>
        const excerpt = post.excerpt
            ? `<div class="font-serif text-stone-500 text-[0.95rem] leading-relaxed text-justify md:text-left" style="text-justify: inter-ideograph;">
                 ${dateDesktop}
                 ${renderTweetContent(escapeHtml(post.excerpt))}
               </div>
               ${dateMobile}`
            : `${dateDesktop}${dateMobile}`;

        return `
            <article class="fade-up py-7 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
                <a href="/tweet/${encodeURIComponent(slug)}" class="block">
                    ${excerpt}
                </a>
            </article>
        `;
    }

    // 文章渲染：标题 + 日期(右侧同行) + 摘要
    const title = escapeHtml(post.title || '未命名');
    const excerpt = post.excerpt
        ? `<p class="mt-2.5 font-serif text-stone-500 text-[0.95rem] leading-relaxed text-justify md:text-left" style="text-justify: inter-ideograph;">${escapeHtml(post.excerpt)}</p>`
        : '';
    const viewsHtml = showViews ? renderViewsIcon(post.views) : '';
    return `
        <article class="fade-up py-7 group" style="animation-delay: ${i * 40}ms" data-ssr-item>
            <a href="/post/${encodeURIComponent(slug)}" class="block">
                <div class="flex flex-col md:flex-row md:items-baseline justify-between gap-2 md:gap-6">
                    <h2 class="font-serif text-xl md:text-[1.35rem] leading-snug text-stone-900 group-hover:text-stone-600 transition-colors">
                        <span class="link-underline pb-0.5">${title}</span>
                    </h2>
                    <div class="flex items-center gap-3 text-xs text-stone-400 tabular-nums tracking-wider pt-1 md:pt-1.5">
                        ${viewsHtml}
                        <time class="font-sans">${formatDate(post.created_at)}</time>
                    </div>
                </div>
                ${excerpt}
            </a>
        </article>
    `;
}

/**
 * 推文专用渲染器(用于 /tweets 页面)
 * - 推特式样: 头像 + 昵称 + 发布时间 + 正文(去除左侧 border-l 竖杠)
 * - avatar 缺省时回退到占位 SVG;<img> 加载失败时也回退到占位
 * - 数据契约: post.author = { nickname: string|null, avatar: string|null } | null
 */
export function renderTweetItem(post, i) {
    if (!post) return '';
    const slug = post.slug || '';
    const raw = (post.content != null && post.content !== '') ? post.content : (post.excerpt || '');
    const dateStr = formatDate(post.created_at);
    const author = post.author || null;
    const nickname = (author && author.nickname) ? author.nickname : 'Admin';
    const avatar = (author && author.avatar) ? author.avatar : null;

    // 头像区: 有 URL → <img> + 占位 SVG(hidden); 无 URL → 仅占位
    const placeholderPath = 'M12 12c2.7 0 4.875-2.175 4.875-4.875S14.7 2.25 12 2.25 7.125 4.425 7.125 7.125 9.3 12 12 12zm0 2.25c-3.45 0-10.125 1.725-10.125 5.25v2.25h20.25v-2.25c0-3.525-6.675-5.25-10.125-5.25z';
    const avatarInner = avatar
        ? `<img class="w-full h-full object-cover" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
           <svg class="w-5 h-5 text-stone-300 hidden" fill="currentColor" viewBox="0 0 24 24"><path d="${placeholderPath}"/></svg>`
        : `<svg class="w-5 h-5 text-stone-300" fill="currentColor" viewBox="0 0 24 24"><path d="${placeholderPath}"/></svg>`;

    const timeHTML = dateStr
        ? `<time class="text-stone-400 text-xs font-sans tabular-nums whitespace-nowrap">${dateStr}</time>`
        : '';

    return `
        <article class="fade-up group" style="animation-delay: ${i * 40}ms" data-ssr-item>
            <a href="/tweet/${encodeURIComponent(slug)}" class="flex gap-3 px-3 py-3 -mx-3 rounded-lg hover:bg-stone-100/60 transition-colors">
                <div class="shrink-0">
                    <div class="w-10 h-10 md:w-11 md:h-11 rounded-full bg-stone-100 border border-stone-200/60 overflow-hidden flex items-center justify-center">
                        ${avatarInner}
                    </div>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-baseline gap-2 flex-wrap text-sm leading-tight">
                        <span class="font-medium text-stone-900 truncate">${escapeHtml(nickname)}</span>
                        ${timeHTML}
                    </div>
                    <div class="font-serif text-stone-700 text-base leading-relaxed whitespace-pre-wrap break-words mt-1">${renderTweetContent(escapeHtml(raw))}</div>
                </div>
            </a>
        </article>
    `;
}