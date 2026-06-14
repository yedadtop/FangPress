# FangPress · 独立博客

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
- **本地发布**：支持本地php发布/修改文章，无需登录博客后台。
- **Ai提示词**：带AI提示词提示词 [prompt.md](./prompt.md) ，直接喂给大模型即可生成符合本系统数据库结构的文章 JSON。

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

## 🚀 快速开始

部署一个 FangPress 实例只需 5 步：

1. **Fork / Clone** 本仓库到你的 GitHub。
2. 在 **Cloudflare Dashboard** 创建一个 Pages 项目并连接该仓库（构建命令留空，构建输出目录留空即可，全是静态资源 + Functions）。
3. 在 Cloudflare 创建 **D1 数据库**、**R2 存储桶**、**KV 命名空间**，并绑定到 Pages。
4. 在 Pages 控制台的 **「设置 → 环境变量」** 配置 `API_TOKEN` 等。
5. 首次部署完成后，进 D1 控制台的查询页面 **执行 [sql.txt](./sql.txt) 中的语句** 初始化表结构与默认管理员。

部署完成访问你的地址（默认地址 `https://<your-project>.pages.dev`），默认账号密码 `admin / admin`，**登录后立刻改密码**。

---

## ☁️ Cloudflare 控制台配置

### 1. 创建 Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 选择本仓库，框架预设选 **None**。
3. **Build command** 留空，**Build output directory** 留空（项目无构建步骤，纯静态 + Functions）。
4. 点击 **Save and Deploy**，等首次部署完成（此时 Functions 会因尚未绑定资源而 500，**正常**）。

### 2. 绑定 D1 数据库

1. 左侧菜单 **Workers & Pages → Storage → D1 SQL Database → Create database**。
2. 名称建议：`blog-db`（或自定义），记下 **Database ID**。
3. 回到 Pages 项目 → **Settings → Functions → D1 database bindings** → **Add binding**：
   - Variable name: **`DB`**
   - D1 database: 选择上一步创建的数据库
4. 保存。

> 绑定变量名必须叫 `DB`，代码中 `env.DB.prepare(...).bind(...)` 即此绑定。

### 3. 绑定 R2 存储桶

1. 左侧 **R2 → Create bucket**，名称建议：`blog-images`。
2. 回到 Pages 项目 → **Settings → Functions → R2 bucket bindings** → **Add binding**：
   - Variable name: **`R2_BUCKET`**
   - R2 bucket: 选择上一步创建的桶
3. （可选）为 R2 桶配置**公开访问**：
   - 进入 R2 → 选中 `blog-images` → **Settings → Public access → Allow Access**。
   - 记下形如 `https://pub-XXXXXX.r2.dev` 的 **公开访问域名**，下一步用。

> 绑定变量名必须叫 `R2_BUCKET`。

### 4. 绑定 KV 命名空间

1. 左侧 **Workers & Pages → Storage → KV → Create a namespace**。
2. 名称建议：`blog-kv`。
3. 回到 Pages 项目 → **Settings → Functions → KV namespace bindings** → **Add binding**：
   - Variable name: **`KV`**
   - KV namespace: 选择上一步创建的命名空间
4. 保存。

> 绑定变量名必须叫 `KV`。

### 5. 配置环境变量 / 密钥

Pages 项目 → **Settings → Environment variables** → **Add**：

| 变量名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `API_TOKEN` | 纯文本 | 推荐 | 任意非空字符串；用此 token 调所有受保护接口（除 `/api/user/update`），适合脚本 / CI |
| `R2_PUBLIC_URL` | 纯文本 | 必填 | 第 3 步 R2 桶的公开访问域名，例：`https://pub-abc123.r2.dev`；用于从 Markdown 抽取 R2 图片 key |
| `CUSTOM_DOMAIN` | 纯文本 | 可选 | 仅备忘用；想用自定义域名，在 **Custom domains** 里绑定即可 |

> ⚠️ 改完环境变量一定要 **重新部署** 一次才生效。

### 6. 初始化数据库（执行 SQL）

1. Cloudflare Dashboard → **Workers & Pages → Storage → D1** → 选中 `blog-db` → **Console** 标签。
2. 把 [sql.txt](./sql.txt) 里的 SQL 整段粘贴到输入框，点击 **Execute**。
3. 成功后表结构与默认管理员已就绪：
   - 用户名：`admin`
   - 密码（明文）：`admin`
   - 密码（SHA-256）：`8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918`

4. 重新打开你的 Pages 站点，登录后请立刻通过 **控制台 → 账户** 改密并设置强密码。

### 📸 实际配置参考（截图对应）

下面是一份**真实可用的最小配置**，与 Cloudflare Pages → **Settings → Variables and Secrets**、**Settings → Bindings** 两个面板的字段一一对应，照着填即可：

#### 变量和密钥

| 类型 | 名称 | 值（示例） |
| --- | --- | --- |
| 纯文本 | `API_TOKEN` | `GhzoDocLALVRbPwhqztrezhim5YgkvyEa`（任意随机强字符串） |
| 纯文本 | `R2_PUBLIC_URL` | `https://img.yedad.top`（你的 R2 桶公开访问域名，**末尾不要带 `/`**） |

#### 绑定

| 类型 | 名称 | 绑定到（值） |
| --- | --- | --- |
| KV 命名空间 | `KV` | `TEST_BLOG_KV`（先在 **Storage → KV** 创建一个 Namespace，名字自取） |
| D1 数据库 | `DB` | `blog-asia`（先在 **Storage → D1** 创建一个 Database，名字自取） |
| R2 存储桶 | `R2_BUCKET` | `blog-images`（先在 **R2 → Create bucket** 创建一个桶，名字自取） |

> ⚠️ 几个**强约束**（写错代码读不到资源，直接 500）：
> 1. **变量名必须严格一致**：`KV` / `DB` / `R2_BUCKET` / `API_TOKEN` / `R2_PUBLIC_URL` —— 代码里 `env.KV`、`env.DB`、`env.R2_BUCKET` 就是按这几个名字取的。
> 2. **类型不要选错**：API_TOKEN / R2_PUBLIC_URL 选「纯文本（Plaintext）」即可，不要选「加密（Encrypt）」，否则 Functions 端读不到。
> 3. **绑定生效需要重新部署一次**（Save 完回到 **Deployments → Retry deployment**），仅保存不会自动热加载。
> 4. **R2 公开域名要先开**：进 R2 → 选中 `blog-images` → **Settings → Public access → Allow Access**，拿到形如 `https://pub-XXXXXX.r2.dev` 的域名；如果你用自己的 CDN / 鉴权域名（如图里的 `https://img.yedad.top`），同样直接填进 `R2_PUBLIC_URL` 即可。

---

## 🗄️ 数据库表结构（`sql.txt` 折叠）

> 完整 SQL 较长，折叠如下。点击展开后整段复制到 D1 Console 执行即可。

<details>
<summary>👉 点击展开 <code>sql.txt</code> 完整 SQL</summary>

```sql
-- functions/sql.txt

DROP TABLE IF EXISTS site_navs;
DROP TABLE IF EXISTS site_settings;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;

-- 1. 创建用户表
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nickname TEXT,
    avatar TEXT,
    created_at TEXT NOT NULL
);

-- 2. 创建文章表（已包含高性能优化所需的 excerpt 字段以及新增的 type 字段）
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

-- 3. 建立关键索引，压榨 SQLite 扫描性能
CREATE INDEX idx_posts_slug ON posts(slug);
CREATE INDEX idx_posts_category ON posts(category);
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_type ON posts(type);

-- 4. 创建站点选项表
CREATE TABLE site_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 5. 注入初始管理员（默认账号 admin，密码哈希已就绪）
INSERT INTO users (username, password_hash, nickname, created_at) VALUES
    ('admin', '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918', 'Admin', '2026-06-12T05:00:00.000Z');

-- 6. 注入系统核心配置项（已修复断行并规避时区差异）
INSERT INTO site_settings (key, value, updated_at) VALUES
    ('site_title',     'Quinn''s Space',                                        '2026-06-12T05:00:00.000Z'),
    ('site_subtitle',  '基于 Cloudflare Pages & D1 关系型数据库的纯文字内容流',    '2026-06-12T05:00:00.000Z'),
    ('show_views',     '1',                                                     '2026-06-12T05:00:00.000Z'),
    ('excerpt_length', '200',                                                   '2026-06-12T05:00:00.000Z'),
    ('home_mode',      'mix',                                                   '2026-06-12T05:00:00.000Z');

-- 7. 创建站点导航表（header 上的链接，可后台动态增删改）
CREATE TABLE site_navs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,                  -- 显示文字，例如「文章」「推文」「关于」
    href  TEXT NOT NULL,                  -- 跳转 URL，例如 /posts、https://example.com
    tab_key TEXT DEFAULT NULL,            -- 与页面 body[data-active-tab] 对应的键；用于高亮；外部链接留空
    open_in_new_tab INTEGER NOT NULL DEFAULT 0, -- 是否在新窗口打开（0/1）
    is_active     INTEGER NOT NULL DEFAULT 1,    -- 是否启用（0/1）
    sort_order    INTEGER NOT NULL DEFAULT 0,    -- 排序（升序）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_site_navs_active ON site_navs(is_active, sort_order);

-- 8. 注入默认导航项（沿用旧版静态导航的内容）
INSERT INTO site_navs (label, href, tab_key, open_in_new_tab, is_active, sort_order, created_at, updated_at) VALUES
    ('文章', '/posts',  'posts',  0, 1, 10, '2026-06-12T05:00:00.000Z', '2026-06-12T05:00:00.000Z'),
    ('推文', '/tweets', 'tweets', 0, 1, 20, '2026-06-12T05:00:00.000Z', '2026-06-12T05:00:00.000Z');
```

</details>

> 📁 源文件路径：[sql.txt](./sql.txt)

---

## 🧪 本地开发

Cloudflare Pages Functions 推荐用 [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) 起本地服务：

```bash
# 安装 wrangler（如未安装）
npm install -g wrangler

# 在项目根目录起本地 Pages 模拟器（端口 8788）
wrangler pages dev . --port 8788
```

> 由于本地没有真实的 D1 / R2 / KV，本地预览时大部分 API 会 500。
> 真要本地起全套请使用 **Cloudflare 远程绑定**（`wrangler pages dev --remote`），需要登录 CF 账号。

如果只是想看前端样式与 SSR 渲染，**最简单的方式**是进 [`php/`](./php) 起一个 `php -S 0.0.0.0:8000`，配合一个 mock 的 `/api` 路由就能跑。

---

## 📖 配套文档

- 📘 **API 详细文档**：[api.md](./api.md) — 11 个端点、鉴权、错误码、缓存策略、完整 curl 测试脚本
- 🤖 **AI 写稿提示词**：[prompt.md](./prompt.md) — 喂给大模型即可一键产出符合本系统数据库结构的文章 JSON
- 🗄️ **数据库初始化 SQL**：[sql.txt](./sql.txt) — D1 建表 + 索引 + 种子数据
- 🛠️ **Functions 工具库**：[functions/lib/](./functions/lib) — 列表 / 导航 / 时间 / R2 图片抽取

---

## 🔐 默认账号与安全建议

| 项 | 默认值 |
| --- | --- |
| 用户名 | `admin` |
| 密码（明文） | `admin` |
| 密码（SHA-256） | `8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918` |

⚠️ **首次登录后请立即**：
1. 进入 **控制台 → 账户信息** 修改密码；
2. 在 **Cloudflare Pages → 环境变量** 设置一个强随机的 `API_TOKEN`，用于脚本自动化；
3. 给 Pages 项目绑定 **GitHub 仓库的 secrets**，避免密钥进 git；
4. R2 桶公开访问域名前建议套一层 **Cloudflare CDN + Referer 防盗链**（在 R2 → Settings → CORS / Custom domain 中设置）。

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
