// search-overlay.js
// 全局搜索浮层（被 index.html / posts.html / tweets.html 共用）
// 提取自原先三个 HTML 文件中重复的 IIFE。
// 设计前提:
//   - 任何页面只要存在 #search-toggle + #search-overlay 节点,本脚本自动接管
//   - 与原行为完全一致:防抖 350ms、竞态 token、键盘 Esc 关闭、点 backdrop 关闭
//   - 推文与文章共用同一结果列表(根据 p.type 区分渲染)
(function () {
    'use strict';

    var toggle = document.getElementById('search-toggle');
    var overlay = document.getElementById('search-overlay');
    if (!toggle || !overlay) return;

    var closeBtn = document.getElementById('search-close');
    var backdrop = document.getElementById('search-backdrop');
    var input = document.getElementById('search-input');
    var results = document.getElementById('search-results');

    var debounceTimer = null;
    var currentToken = 0;
    var DEBOUNCE_MS = 350;

    function escapeHTML(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDate(ts) {
        var d = new Date(ts);
        if (isNaN(d)) return '';
        // ⚡️ 主页风格:仅显示月-日(如 "6-14")
        return (d.getMonth() + 1) + '-' + d.getDate();
    }

    function clearResults() {
        if (!results) return;
        results.innerHTML = '';
        results.classList.add('hidden');
    }

    function showMessage(text) {
        if (!results) return;
        results.innerHTML =
            '<p class="px-5 py-8 font-serif text-stone-500 text-base italic tracking-widest text-center">' +
            escapeHTML(text) +
            '</p>';
        results.classList.remove('hidden');
    }

    function renderList(items) {
        if (!results) return;
        if (!items.length) { showMessage('未找到相关文章'); return; }
        var html = items.map(function (p) {
            var slug = encodeURIComponent(p.slug || '');
            var isTweet = p.type === 'tweet';
            var href = isTweet ? '/tweet/' + slug : '/post/' + slug;

            if (isTweet) {
                var raw = String(p.content || '');
                var excerpt = raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
                var tweetBadge = '<span class="font-medium text-stone-500">推文</span>';
                var dateStr = formatDate(p.created_at);
                var dateHTML = dateStr
                    ? '<span class="tabular-nums">' + escapeHTML(dateStr) + '</span>'
                    : '';
                var tweetSep = dateHTML ? '<span class="text-stone-300">·</span>' : '';
                return '<a href="' + href + '" class="block px-5 py-4 hover:bg-stone-100/60 transition-colors">' +
                    '<p class="font-serif text-sm leading-relaxed text-stone-700 line-clamp-2 whitespace-pre-wrap break-words">' +
                        escapeHTML(excerpt) +
                    '</p>' +
                    '<div class="mt-1.5 flex items-center gap-2 text-xs text-stone-400 tracking-wider font-sans">' +
                        tweetBadge + tweetSep + dateHTML +
                    '</div>' +
                '</a>';
            }

            var title = escapeHTML(p.title || '');
            var cat = p.category ? '<span>' + escapeHTML(p.category) + '</span>' : '';
            var dateStr2 = formatDate(p.created_at);
            var dateHTML2 = dateStr2
                ? '<time class="tabular-nums">' + escapeHTML(dateStr2) + '</time>'
                : '';
            var sep = (cat && dateHTML2) ? '<span class="text-stone-300">·</span>' : '';
            var meta = (cat || dateHTML2)
                ? '<div class="mt-1.5 flex items-center gap-2.5 text-xs text-stone-400 tracking-wider font-sans">' +
                    cat + sep + dateHTML2 +
                  '</div>'
                : '';
            return '<a href="' + href + '" class="block px-5 py-4 hover:bg-stone-100/60 transition-colors">' +
                '<h3 class="font-serif text-base md:text-lg leading-snug text-stone-900 link-underline pb-0.5">' +
                    title +
                '</h3>' +
                meta +
            '</a>';
        }).join('');
        results.innerHTML = html;
        results.classList.remove('hidden');
    }

    function cancelPending() {
        if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
        currentToken++;
    }

    // 解析日期输入:支持 YYYY[sep]M[sep]D、YYYY-MM-DD、YYYY.M.D、2026-2-06 等
    // 任意非数字字符视为分隔符;返回规范化的 YYYY-MM-DD,无效返回 null
    function parseDateInput(raw) {
        var m = String(raw).match(/^(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})$/);
        if (!m) return null;
        var y = parseInt(m[1], 10);
        var mo = parseInt(m[2], 10);
        var d = parseInt(m[3], 10);
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        var test = new Date(Date.UTC(y, mo - 1, d));
        if (test.getUTCFullYear() !== y ||
            test.getUTCMonth() !== mo - 1 ||
            test.getUTCDate() !== d) return null;
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return y + '-' + pad(mo) + '-' + pad(d);
    }

    function fetchSearch(url) {
        cancelPending();
        showMessage('搜索中…');
        var token = currentToken;
        debounceTimer = setTimeout(function () {
            debounceTimer = null;
            fetch(url, {
                headers: { 'Accept': 'application/json' },
                cache: 'no-store'
            })
            .then(function (r) { return r.json(); })
            .then(function (json) {
                if (token !== currentToken) return;
                if (json && json.success && Array.isArray(json.data)) {
                    renderList(json.data);
                } else {
                    showMessage('未找到相关文章');
                }
            })
            .catch(function () {
                if (token !== currentToken) return;
                showMessage('搜索失败，请稍后再试');
            });
        }, DEBOUNCE_MS);
    }

    function runKeywordSearch(keyword) {
        fetchSearch('/api/search?q=' + encodeURIComponent(keyword));
    }

    function runDateSearch(dateStr) {
        fetchSearch('/api/search?date=' + encodeURIComponent(dateStr));
    }

    var open = function () {
        overlay.classList.remove('hidden');
        requestAnimationFrame(function () { if (input) input.focus(); });
    };
    var close = function () {
        overlay.classList.add('hidden');
        if (input) input.value = '';
        cancelPending();
        clearResults();
    };

    toggle.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (backdrop) backdrop.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });

    if (input) {
        input.addEventListener('input', function () {
            var keyword = input.value.trim();
            if (!keyword) { cancelPending(); clearResults(); return; }
            var dateStr = parseDateInput(keyword);
            if (dateStr) {
                runDateSearch(dateStr);
            } else {
                runKeywordSearch(keyword);
            }
        });
    }
})();
