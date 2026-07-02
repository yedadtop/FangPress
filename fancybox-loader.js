// fancybox-loader.js
// 图片灯箱按需加载器
// 首次点击 .tweet-img / .prose-reader img 时才注入 FancyBox 的 CSS/JS，
// 避免首页/详情页在「没有图片交互」的场景下承担额外的网络与解析开销。
// 加载完成后，构造图片列表并通过编程式 API 拉起灯箱（无需 data-fancybox 属性，支持懒加载新追加的图片）。
(function () {
    'use strict';

    var CSS_HREF = 'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.css';
    var JS_SRC = 'https://cdn.jsdelivr.net/npm/@fancyapps/ui@5.0/dist/fancybox/fancybox.umd.min.js';

    var state = 'idle'; // 'idle' | 'loading' | 'ready'
    var pendingCallbacks = [];

    function show(img) {
        var container = img.closest('article[data-ssr-item], .prose-reader, #ssr-tweet-content');
        var imgList = container
            ? Array.prototype.slice.call(container.querySelectorAll('.tweet-img, .prose-reader img'))
            : [img];

        var startIndex = imgList.indexOf(img);
        if (startIndex === -1) startIndex = 0;

        var items = imgList.map(function (node) {
            return { src: node.getAttribute('src') || node.src, type: 'image' };
        });

        window.Fancybox.show(items, { startIndex: startIndex, dragToClose: true });
    }

    function flushPending() {
        var cbs = pendingCallbacks;
        pendingCallbacks = [];
        for (var i = 0; i < cbs.length; i++) {
            try { cbs[i](); } catch (err) { console.error(err); }
        }
    }

    function loadFancybox() {
        if (state === 'ready') return;
        if (state === 'loading') return;
        state = 'loading';

        // 1. 注入 CSS（用 data 属性标记，避免重复注入）
        if (!document.querySelector('link[data-fancybox-css]')) {
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = CSS_HREF;
            link.setAttribute('data-fancybox-css', '');
            document.head.appendChild(link);
        }

        // 2. 注入 JS
        var script = document.createElement('script');
        script.src = JS_SRC;
        script.async = true;
        script.onload = function () {
            state = 'ready';
            flushPending();
        };
        script.onerror = function () {
            state = 'idle';
            pendingCallbacks = [];
            console.error('[fancybox-loader] 加载失败:', JS_SRC);
        };
        document.head.appendChild(script);
    }

    document.addEventListener('click', function (e) {
        var img = e.target.closest('.tweet-img, .prose-reader img');
        if (!img) return;

        // 拦截默认行为（防止推文列表中的 <a> 标签发生页面跳转）
        e.preventDefault();
        e.stopPropagation();

        if (state === 'ready' && window.Fancybox) {
            show(img);
            return;
        }

        // 首次点击：开始加载，加载完成后回放本次操作
        pendingCallbacks.push(function () { show(img); });
        loadFancybox();
    }, true); // 捕获阶段，确保在 <a> 标签生效前拦截
})();
