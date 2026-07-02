// tweet-card.js
// 推文卡片渲染器（同构模块）
// 被两个环境共用:
//   1) Cloudflare Functions 端: functions/lib/list-render.js 通过 import 引入
//   2) 浏览器端: tweets.html 通过 <script type="module"> 引入
//
// 设计前提:
//   - 文件内不引用 window/document,只导出纯函数,保证可在 Worker 环境安全 import
//   - SSR 端追加 animation-delay,CSR 端不追加(已经滚动到底部了,无意义)
//   - 头像占位 SVG 路径、推文图片正则均与 SSR 端保持逐字符一致

// === 与 functions/lib/list-render.js 完全等价的纯函数 ===

export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    // ⚡️ 主页风格:仅显示月-日(如 "6-14")
    return (d.getMonth() + 1) + '-' + d.getDate();
}

const TWEET_IMG_RE = /!\[([^\]]*?)\]\((https?:\/\/[^)\s<]+|data:image\/[^)\s<]+)\)/gi;

export function renderTweetContent(escapedHtml) {
    return String(escapedHtml == null ? '' : escapedHtml).replace(
        TWEET_IMG_RE,
        function (m, alt, url) {
            return '<img class="tweet-img" src="' + url + '" alt="' + alt + '" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display=\'none\'" />';
        }
    );
}

const AVATAR_PLACEHOLDER_PATH = 'M12 12c2.7 0 4.875-2.175 4.875-4.875S14.7 2.25 12 2.25 7.125 4.425 7.125 7.125 9.3 12 12 12zm0 2.25c-3.45 0-10.125 1.725-10.125 5.25v2.25h20.25v-2.25c0-3.525-6.675-5.25-10.125-5.25z';

/**
 * 渲染单条推文卡片 HTML
 * @param {Object} p  - 推文数据
 * @param {number} [i] - 序号(仅 SSR 端传,用于错峰动画;CSR 端省略)
 * @returns {string} HTML 字符串
 */
export function renderTweetCard(p, i) {
    if (!p) return '';
    const slug = p.slug || '';
    const raw = (p.content != null && p.content !== '') ? p.content : (p.excerpt || '');
    const d = formatDate(p.created_at);
    const author = p.author || null;
    const nickname = (author && author.nickname) ? author.nickname : 'Admin';
    const avatar = (author && author.avatar) ? author.avatar : null;

    const avatarInner = avatar
        ? '<img class="w-full h-full object-cover" src="' + escapeHtml(avatar) + '" alt="" referrerpolicy="no-referrer" onerror="this.classList.add(\'hidden\'); this.nextElementSibling.classList.remove(\'hidden\');" />' +
          '<svg class="w-5 h-5 text-stone-300 hidden" fill="currentColor" viewBox="0 0 24 24"><path d="' + AVATAR_PLACEHOLDER_PATH + '"/></svg>'
        : '<svg class="w-5 h-5 text-stone-300" fill="currentColor" viewBox="0 0 24 24"><path d="' + AVATAR_PLACEHOLDER_PATH + '"/></svg>';

    const timeHTML = d
        ? '<time class="text-stone-400 text-xs font-sans tabular-nums whitespace-nowrap">' + escapeHtml(d) + '</time>'
        : '';

    const animStyle = (typeof i === 'number') ? ' style="animation-delay: ' + (i * 40) + 'ms"' : '';

    return '<article class="fade-up group"' + animStyle + ' data-ssr-item>' +
        '<a href="/tweet/' + encodeURIComponent(slug) + '" class="flex gap-3 px-3 py-3 -mx-3 rounded-lg hover:bg-stone-100/60 transition-colors">' +
            '<div class="shrink-0">' +
                '<div class="w-10 h-10 md:w-11 md:h-11 rounded-full bg-stone-100 border border-stone-200/60 overflow-hidden flex items-center justify-center">' +
                    avatarInner +
                '</div>' +
            '</div>' +
            '<div class="flex-1 min-w-0">' +
                '<div class="flex items-baseline gap-2 flex-wrap text-sm leading-tight">' +
                    '<span class="font-medium text-stone-900 truncate">' + escapeHtml(nickname) + '</span>' +
                    timeHTML +
                '</div>' +
                '<div class="font-serif text-stone-700 text-base leading-relaxed whitespace-pre-wrap break-words mt-1">' + renderTweetContent(escapeHtml(raw)) + '</div>' +
            '</div>' +
        '</a>' +
    '</article>';
}

// === 仅浏览器端使用的懒加载初始化 ===

/**
 * 初始化推文懒加载(IntersectionObserver)
 * 仅在浏览器中调用,Worker 环境勿用
 */
export function setupTweetLazyLoad() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const list = document.getElementById('ssr-post-list');
    const sentinel = document.getElementById('tweet-load-more-sentinel');
    const loading = document.getElementById('tweet-loading-more');
    const errEl = document.getElementById('tweet-load-error');
    const retryBtn = document.getElementById('tweet-retry');
    const endEl = document.getElementById('tweet-end');
    if (!list || !sentinel) return;

    let hasMore = list.getAttribute('data-has-more') === 'true';
    let nextPage = parseInt(list.getAttribute('data-next-page') || '2', 10);
    let inFlight = false;
    let observer = null;

    function appendItems(items) {
        if (!items || !items.length) return;
        const wrap = document.createElement('div');
        wrap.innerHTML = items.map(renderTweetCard).join('');
        while (wrap.firstChild) list.appendChild(wrap.firstChild);
    }

    function setLoading(v) {
        inFlight = v;
        if (loading) loading.classList.toggle('hidden', !v);
    }

    function showError() { if (errEl) errEl.classList.remove('hidden'); }
    function hideError() { if (errEl) errEl.classList.add('hidden'); }

    function finish(hasNext) {
        hasMore = hasNext;
        if (!hasMore) {
            if (sentinel) sentinel.style.display = 'none';
            if (endEl) endEl.classList.remove('hidden');
            if (observer) observer.disconnect();
        }
    }

    function loadMore() {
        if (inFlight || !hasMore) return;
        hideError();
        setLoading(true);
        fetch('/api/list?type=tweet&page=' + nextPage, {
            headers: { 'Accept': 'application/json' },
            cache: 'no-store'
        })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function (json) {
            let items = null;
            let hasNext = false;
            if (Array.isArray(json)) {
                items = json;
            } else if (json && typeof json === 'object') {
                if (json.success === false) { showError(); return; }
                if (Array.isArray(json.data)) {
                    items = json.data;
                    hasNext = json.has_more === true;
                } else if (Array.isArray(json.items)) {
                    items = json.items;
                    hasNext = json.has_more === true || json.hasMore === true;
                }
            }
            hideError();
            if (Array.isArray(items)) {
                if (items.length) {
                    appendItems(items);
                    nextPage++;
                    list.setAttribute('data-next-page', String(nextPage));
                    finish(hasNext);
                } else {
                    finish(false);
                }
            } else {
                showError();
            }
        })
        .catch(function () { showError(); })
        .then(function () { setLoading(false); });
    }

    if (retryBtn) {
        retryBtn.addEventListener('click', function (e) {
            e.preventDefault();
            loadMore();
        });
    }

    if (!hasMore) {
        if (sentinel) sentinel.style.display = 'none';
        if (endEl) endEl.classList.remove('hidden');
        return;
    }

    if (!('IntersectionObserver' in window)) {
        let triggered = false;
        window.addEventListener('scroll', function () {
            if (triggered || inFlight || !hasMore) return;
            const rect = sentinel.getBoundingClientRect();
            if (rect.top < (window.innerHeight || document.documentElement.clientHeight) + 300) {
                triggered = true;
                loadMore();
                setTimeout(function () { triggered = false; }, 200);
            }
        }, { passive: true });
        return;
    }

    observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (entry.isIntersecting) loadMore();
        });
    }, { rootMargin: '300px 0px' });
    observer.observe(sentinel);
}

// 仅在浏览器中作为 <script type="module"> 直接加载时,自动调用 setupTweetLazyLoad
// 通过全局 window.__tweetCardLoaded 标志避免重复初始化
if (typeof window !== 'undefined' && !window.__tweetCardLoaded) {
    window.__tweetCardLoaded = true;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupTweetLazyLoad);
    } else {
        setupTweetLazyLoad();
    }
}
