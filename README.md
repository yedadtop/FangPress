# FangPress · 一套基于 Cloudflare Pages D1 R2 KV 的极简博客系统

> 基于 **Cloudflare Pages + D1（SQLite）+ R2 + KV** 的一套**零服务器、零成本、纯静态前端 + 边缘函数**的极简独立博客系统。
> 主打「纯文字内容流」、强调阅读体验，配合 AI 写稿工作流与可视化后台，让单人独立博客的搭建与维护成本降到极限。

![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-F38020?logo=cloudflare&logoColor=white)
![D1](https://img.shields.io/badge/Storage-D1_F38020?logo=cloudflare&logoColor=white)
![R2](https://img.shields.io/badge/Storage-R2_F38020?logo=cloudflare&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

---

## ✨ 项目简介

**FangPress** 是一套完全跑在 Cloudflare 边缘网络上的个人博客系统，前端是纯 HTML + 原生 JS + Tailwind CSS（CDN），后端逻辑全部用 **Pages Functions（Workers）** 实现，数据落地到 **D1**（Cloudflare 托管的 SQLite），图片落到 **R2** 对象存储，热点数据用 **KV** 做边缘缓存。

整套方案的特点：

- **零服务器**：不需要任何 VPS / 容器 / 域名备案；
- **零成本**：Cloudflare 免费额度足够个人博客跑到天荒地老；
- **零运维**：部署即上线，写文章走后台或 API；
- **本地发布**：支持本地php页面发布/修改文章，无需登录博客后台。
- **Ai提示词**：带AI提示词 [prompt.md](./prompt.md) ，直接喂给大模型即可生成符合本系统数据库结构的文章 JSON。
- **响应式自适应**：基于 Tailwind CSS v4 的响应式断点（`sm / md / lg / xl`）做了完整的**移动端 / 平板 / PC 三端适配**。

---

## 🚀 功能特性

| 模块 | 说明 |
| --- | --- |
| 📝 文章管理 | 支持 Markdown 写作，文章 / 推文 `type` 分流，统一在 `/api/push` 一个端点写入 |
| 🐦 推文（轻量短内容） | 与文章共用 `posts` 表，`type='tweet'`；自动生成 `t-<时间戳>-<随机>` slug，title 可空 |
| 🧭 站点导航 | `site_navs` 表，后台可视化增删改 + 拖拽排序 + 启用/禁用，KV 缓存 + SSR 即时生效 |
| 🖼️ 图片管理 | 上传至 R2，Markdown 自动识别 `![alt](R2_PUBLIC_URL/...)` 形式的图片，删除文章时联动清理 R2 对象 |
| 🔐 鉴权 | 单管理员模型，token = `SHA-256(password)`，支持环境变量 `API_TOKEN`（除账户接口外） |
| 👤 账户管理 | 改用户名 / 昵称 / 头像 / 密码；头像仅接受 http/https 直链 |
| 🗃️ 管理后台 | `admin*.html` 6 个页面（总览 / 文章 / 导航 / 设置 / 数据库 / 账户），零构建直接打开 |
| 📊 数据导出 | 管理后台「数据库」页支持 KV + D1 双向导入导出，备份与迁移方便 |

---

## � 页面预览

下面是项目实际跑起来后的几张关键页面截图，全部 360px～1920px 响应式自适应：

### 🏠 主页 / 文章 / 推文列表

| 文章列表 | 推文列表 | 搜索 |
| :---: | :---: | :---: |
| ![posts](screenshot/posts.png) | ![tweets](screenshot/tweets.png) | ![search](screenshot/search.png) |

### 🛠️ 管理后台

| 后台首页 | 数据库管理 |
| :---: | :---: |
| ![admin](screenshot/admin.png) | ![database](screenshot/database.png) |

> 📁 截图源文件位于 [screenshot/](./screenshot/) 目录。

---


## 🚀 快速开始

部署一个 FangPress 实例只需 5 步：

> 💡 也可以不 Fork 仓库，**直接下载本项目压缩包 → Cloudflare Pages → Upload assets**（直接上传）也完全可以，绑定、SQL 初始化等步骤与下方一致。

1. **Fork / Clone** 本仓库到你的 GitHub（或者下载 ZIP 压缩包）。
2. 在 **Cloudflare Dashboard** 创建一个 Pages 项目并连接该仓库 / 上传压缩包（构建命令留空，构建输出目录留空即可，全是静态资源 + Functions）。
3. 在 Cloudflare 创建 **D1 数据库**、**R2 存储桶**、**KV 命名空间**，并绑定到 Pages（详见下方 [☁️ Cloudflare 控制台配置](#️-cloudflare-控制台配置)）。
4. 在 Pages 控制台的 **「设置 → 环境变量」** 配置 `API_TOKEN` 等（详见下方 [☁️ Cloudflare 控制台配置](#️-cloudflare-控制台配置)）。
5. 首次部署完成后，进 D1 控制台的查询页面 **执行 [sql.txt](./sql.txt) 中的语句** 初始化表结构与默认管理员。

<div style="text-align:center; font-size:1.4em; font-weight:600; padding:1.2em 0; margin:1em 0; border-top:1px dashed #ccc; border-bottom:1px dashed #ccc;">

🚀 部署完成访问你的地址（默认地址 `https://<your-project>.pages.dev`），默认账号密码 `admin / admin`，**登录后立刻改密码**。

</div>

---

## ☁️ Cloudflare 控制台配置

### 1. 创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 选择本仓库，框架预设选 **None**。
3. **Build command** 留空，**Build output directory** 留空（项目无构建步骤，纯静态 + Functions）。
4. 点击 **Save and Deploy**，等首次部署完成（此时 Functions 会因尚未绑定资源而 500，**正常**）。

### 2. 创建 D1 / R2 / KV 资源

> 这一步**不展开教程**，请自行 Cloudflare 后台操作（搜索「Cloudflare Pages 创建 D1/R2/KV」即可查到大量图文），流程简述：
> 三者创建好后，回到 Pages 项目 → **Settings → Bindings** 添加绑定（详见下一节）。

### 3. 绑定到 Pages Functions（⚠️）

进入 Pages 项目 → **Settings**，添加 **绑定**。绑定时给的「变量名」必须**与下表一字不差**，否则直接500。

| 类型 | 变量名（**必须严格一致**） | 绑定到 |
| --- | --- | --- |
| D1 数据库 | `DB` | 你上一步建的 D1 |
| R2 存储桶 | `R2_BUCKET` | 你上一步建的 R2 桶 |
| KV 命名空间 | `KV` | 你上一步建的 KV |



### 4. 配置环境变量 / 密钥（⚠️）

Pages 项目 → **Settings → Variables and Secrets → Add**，添加 **2 个环境变量**：

| 类型 | 名称（**必须严格一致**） | 值（示例） |
| --- | --- | --- |
| 纯文本 | `API_TOKEN` | `GhzoDocLALRbPwhqztrhimYgkvEa`（任意随机强字符串） |
| 纯文本 | `R2_PUBLIC_URL` | `https://xxxx.xxx`（你的 R2 桶公开访问域名，**末尾不要带 `/`**） |

> ⚠️ 改完一定要 **重新部署一次** 才生效。

### 5. 初始化数据库（执行 SQL）

1. Cloudflare Dashboard → **Workers & Pages → Storage → D1** → 选中你建的 D1→ **Query** 标签。
2. 点开下方折叠的 **「👉 点击展开SQL」**  SQL 复制，粘贴到输入框，点击 **Run**（源文件[sql.txt](./sql.txt)，不要一次性运行全部，一次只能运行一条语句）
<details>
<summary>👉 点击展开完整 SQL</summary>

```sql

DROP TABLE IF EXISTS site_navs;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT,
    created_at TEXT NOT NULL
);


CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    slug TEXT UNIQUE NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT DEFAULT '',
    category TEXT DEFAULT '未分类',
    type TEXT NOT NULL DEFAULT 'post',
    views INTEGER DEFAULT 0,
    status TEXT DEFAULT 'published',
    author_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX idx_posts_slug ON posts(slug);
CREATE INDEX idx_posts_category ON posts(category);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_type ON posts(type);

CREATE TABLE site_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT INTO users (username, password_hash, nickname, created_at) VALUES
    ('admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'Admin', '2026-06-12T05:00:00.000Z');

INSERT INTO site_settings (key, value, updated_at) VALUES
    ('site_title',     'Quinn''s Space',                                        '2026-06-12T05:00:00.000Z'),
    ('site_subtitle',  '基于 Cloudflare Pages & D1 关系型数据库的纯文字内容流',    '2026-06-12T05:00:00.000Z'),
    ('show_views',     '1',                                                     '2026-06-12T05:00:00.000Z'),
    ('excerpt_length', '200',                                                   '2026-06-12T05:00:00.000Z'),
    ('home_mode',      'mix',                                                   '2026-06-12T05:00:00.000Z');

CREATE TABLE site_navs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL, 
    href  TEXT NOT NULL,
    tab_key TEXT DEFAULT NULL,
    open_in_new_tab INTEGER NOT NULL DEFAULT 0,
    is_active     INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_site_navs_active ON site_navs(is_active, sort_order);

INSERT INTO site_navs (label, href, tab_key, open_in_new_tab, is_active, sort_order, created_at, updated_at) VALUES
    ('文章', '/posts',  'posts',  0, 1, 10, '2026-06-12T05:00:00.000Z', '2026-06-12T05:00:00.000Z'),
    ('推文', '/tweets', 'tweets', 0, 1, 20, '2026-06-12T05:00:00.000Z', '2026-06-12T05:00:00.000Z');
```

</details>


#### 🔐 默认账号与安全建议

| 项 | 默认值 |
| --- | --- |
| 用户名 | `admin` |
| 密码（明文） | `admin` |
| 密码（SHA-256） | `8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918` |

⚠️ **首次登录后请立即**：
1. 进入 **控制台 → 账户信息** 修改用户名/密码；

---

## 🔌 API 二次开发

FangPress 的后端**完全 API 驱动**：网页 / 后台只是「壳」，所有写操作（发布 / 修改 / 删除文章、上传图片、修改站点设置、改导航、改账户）最终都走 [api.md](./api.md) 里那 11 个 JSON 端点。**任何能发 HTTP 请求的程序都是合法客户端** —— 浏览器、手机 App、CLI、CI 脚本都可以。

### 本地 PHP 后台 = API 的一个客户端

仓库自带的 [php/](./php) 目录并不是一个独立的后台，它只是 [api.md](./api.md) 的一个 **PHP 客户端**：

| PHP 里的动作 | 实际调用 |
| --- | --- |
| 「发布」按钮 | `POST /api/push`（带 Bearer Token） |
| 「保存修改」按钮 | `POST /api/update` |
| 「删除」按钮 | `POST /api/delete` |
| 「上传图片」 | `POST /api/upload` |
| 「加载详情」 | `GET  /api/get?slug=...` |

PHP 端仅做了两件事：
1. **服务端代理请求**：用 `curl` 在 PHP 里转发 HTTP，**绕开浏览器 CORS**（Pages Functions 默认同源，但本地 `php -S` 起服务时跨域了）；
2. **渲染一个比后台更轻的表单 UI**：方便在本地起一个 `php -S 0.0.0.0:8000` 就能直接写文章。

所以**本地 PHP 发布 = 走的就是 API**，和网页后台是同一条路。读懂 [api.md](./api.md) 后，你完全可以：

- 写个 **VSCode 插件** 直接 publish（POST `/api/push`）；
- 用 **Obsidian / Typora** 写完导出，一键 curl 上传；
- 写个 **手机端 App** 远程管理；
- 接入 **CI**：GitHub Actions 监听新 Markdown 文件 → 自动调 `/api/push` 发布。

### 最简 curl 示例

发布一篇文章（用 `API_TOKEN` 鉴权，无需登录）：

```bash
curl -X POST https://your-domain/api/push \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title":    "Hello World",
    "slug":     "hello-world",
    "content":  "# 这是我的第一篇文章\n\n正文 Markdown...",
    "category": "随笔",
    "type":     "post"
  }'
```

> 📘 完整 11 个端点 + 鉴权 / 错误码 / 缓存策略 / 批量删除 / 拖拽排序等高级用法：[api.md](./api.md)
> 🛠️ 本地 PHP 后台用法见 [php/index.php](./php/index.php) 顶部注释，先把 [php/config.php](./php/config.php) 里的 `API_BASE` / `API_TOKEN` 改成你自己的域名和 Pages 环境变量即可。

---

## ⚠️ 重要：前端页面的 SSR 渲染机制（改造前必读）

FangPress **公开页面（首页 `/`、文章列表 `/posts`、推文列表 `/tweets`、文章详情 `/post/:slug`、推文详情 `/tweet/:slug`）一律走 Pages Functions 服务端渲染（SSR）**，和后台 `admin-*.html` 完全不同：

### 🔁 两种渲染方式对比

| 维度 | 公开页面（SSR） | 管理后台（CSR） |
| --- | --- | --- |
| 文件 | `index.html` / `posts.html` / `tweets.html` / `post.html` / `tweet.html` | `admin.html` + `admin-*.html` 8 个 |
| 渲染时机 | **请求时**在 Cloudflare 边缘节点用 Functions 把 HTML 拼好再返回 | 浏览器端 JS fetch `/api/*` 后动态渲染 |
| 首屏 | 一次性返回**完整 HTML**（含正文 / 标题 / 日期 / 摘要 / 导航） | 一个空壳 + 多次 fetch 拉数据 |
| 改主题/样式 | **要改两处**（HTML 静态模板 + `functions/lib/*.js` 的 SSR 渲染器） | 只改 `admin-*.html` |
| SEO / 分享 | 极好（搜索引擎 / 微信 / Telegram 卡片能直接抓到正文） | 不友好（首屏是空的） |

### 📂 想改主题 / 样式 / 卡片排版时，**必须同时改**的两类文件

#### 1. 静态 HTML 模板（浏览器端兜底骨架）

- [index.html](./index.html) — 主页骨架
- [posts.html](./posts.html) — 文章列表骨架
- [tweets.html](./tweets.html) — 推文列表骨架
- [post.html](./post.html) — 文章详情骨架
- [tweet.html](./tweet.html) — 推文详情骨架
- [404.html](./404.html) — 404 页

> 这些 HTML 里通常含 `<div id="ssr-post-list"></div>`、`#ssr-site-title` 等「**SSR 注入点**」，Functions 会把渲染好的 HTML 字符串塞进这些节点。骨架 CSS（字体、颜色、容器宽度、阅读器样式）就定义在这些文件里。

#### 2. Functions 端的 SSR 渲染器（真正负责拼内容）

| 文件 | 职责 |
| --- | --- |
| [functions/index.js](./functions/index.js) | 主页 `/` 的路由 + SSR |
| [functions/posts.js](./functions/posts.js) | `/posts` 列表 SSR |
| [functions/tweets.js](./functions/tweets.js) | `/tweets` 列表 SSR |
| [functions/post/[slug].js](./functions/post/%5Bslug%5D.js) | 文章详情 SSR |
| [functions/tweet/[slug].js](./functions/tweet/%5Bslug%5D.js) | 推文详情 SSR |
| **[functions/lib/list-render.js](./functions/lib/list-render.js)** | ⭐ **列表项的 HTML 模板**（标题字号、摘要样式、推文 R2 卡片、桌面/移动端日期布局、动画 `fade-up` 等） |
| [functions/lib/nav-render.js](./functions/lib/nav-render.js) | header 导航的 HTML |
| [functions/lib/marked.esm.js](./functions/lib/marked.esm.js) | Markdown → HTML（决定正文里代码块 / 引用 / 列表怎么渲染） |
| [functions/lib/r2-images.js](./functions/lib/r2-images.js) | 抽取 R2 图片 key + 删除联动 |
| [functions/lib/time.js](./functions/lib/time.js) | 时间格式化 |

> 📌 **举个最常见的踩坑场景**：你嫌「文章列表的标题字号太大」，只改了 `index.html` 里的 CSS，结果**首页首页**（首次访问、SSR）字体没变，要 Ctrl+F5 强刷也没用 —— 因为 SSR 是在 `functions/lib/list-render.js` 里把 HTML 字符串拼好后塞进去的，**那个拼好的 `<h2>` 才是真正控制字号的源头**。同理，文章正文的样式是 `functions/lib/marked.esm.js` 决定的，不是 `post.html`。

### 🧪 怎么验证你的修改对 SSR 生效？

1. 改完先 `git commit` → push，让 Pages 自动重新部署；
2. 浏览器打开页面 → **右键 → 查看网页源代码**（不是 F12 Elements）；
3. 在源码里直接搜你改的 class / 文字 / 样式规则 —— **能搜到** 就说明 SSR 已生效；搜不到就是只改了 HTML 模板，Functions 没读到。

> 看到「View Source: `<h2 class="font-serif text-xl ...">我的标题</h2>`」这样的源码，**就对了**。说明标题是 SSR 拼出来的，不是浏览器后填的。

### 🚫 不要改的地方

- `functions/api/*` 下的 JSON 接口（`/api/list`、`/api/push` 等）—— 这是数据层，**只返回 JSON**，不输出 HTML，改了会让公开页 500；
- `sql.txt` 里的字段 —— 改完记得同步改 `functions/api/*` 里的 SQL，否则读写不一致。

---

## ❓ 常见问题

<details>
<summary><b>Q1：部署后页面打开 500 / API 全部 500？</b></summary>

大概率是 D1 / R2 / KV 没绑定，或者变量名不是 `DB` / `R2_BUCKET` / `KV`。回 **Pages → Settings → Functions** 三个 binding 都检查一遍，再 **重新部署** 一次。

</details>

<details>
<summary><b>Q2：D1 Console 粘贴 <code>sql.txt</code> 报错「table already exists」？</b></summary>

脚本里第一段是 `DROP TABLE IF EXISTS ...`，在 D1 Console 里**一次执行整段**即可。如果只挑了 INSERT 部分单独执行就会冲突。

</details>

<details>
<summary><b>Q3：改了设置 / 发了文章，首页没立刻更新？</b></summary>

KV 缓存键 `site:posts:list:*` / `site:navs:list:active` 写时**已主动清空**，理论上即时生效。如仍异常：
- Pages → **Settings → Functions → KV** 里点 **「Clear data」** 即可清空全部缓存。
- 或进 D1 Console 跑：`DELETE FROM posts WHERE id=...;` 后再观察。

</details>

<details>
<summary><b>Q4：想换域名？</b></summary>

Pages → **Custom domains → Set up a custom domain** → 按提示加 CNAME 即可，证书自动签发。

</details>

<details>
<summary><b>Q5：图片上传到 R2 后，Markdown 里怎么写？</b></summary>

直接写标准的 Markdown 图片语法即可：

```markdown
![alt](https://pub-XXXXXX.r2.dev/2026/06/14/foo.png)
```

只要 `R2_PUBLIC_URL` 配对，删除文章时会**自动联动清理**对应 R2 对象。

</details>

---

## 📝 License
MIT License. 详见 [LICENSE](./LICENSE)（如未提供，按 MIT 默认理解，欢迎自由 fork / 二次开发）。
---
> 文档版本：2026-06-14
> 配套：[**api.md**](./api.md) · [**prompt.md**](./prompt.md) · [**sql.txt**](./sql.txt)
