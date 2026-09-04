# JAVBUS 私有影视搜索源

把本地影视磁力索引接入 JAVBUS 客户端，作为一个**可按关键词搜索**的私有数据源。

## 这是什么

- 一份 **JAVBUS 插件 JSON**：声明式配置，告诉 JAVBUS 去哪个 API 搜资源。
- 一个 **EdgeOne Makers 上的搜索 API**（`edgeone-api/`）：把剧集库 + 影视库合并建索引，按片名子串做模糊搜索。

数据规模：剧集 115,409 条 + 影视 58,175 条 = **173,584** 条。

## 安装插件（JAVBUS 客户端）

在 JAVBUS 的「数据源 / JSON 插件」里添加，URL 填：

```
https://raw.githubusercontent.com/Carolove7/javbus-juji-plugin/master/javbus-plugin.json
```

安装后，在搜索框输入**任意部分片名**即可模糊搜索（大小写不敏感、子串匹配），无需完整片名前缀。

> 旧版分开的 `javbus-plugin-juji.json` / `javbus-plugin-yingshi.json` 已合并为本文件，无需再装两个。

## 搜索 API

服务部署在已绑定自定义域名的 EdgeOne Makers 项目，公网地址 `https://mg.147771.xyz`。

| 端点 | 说明 |
|------|------|
| `GET /search?q=<词>&page=<n>` | **剧集 + 影视合并搜索**（插件用这个） |
| `GET /juji?q=<词>&page=<n>`   | 仅剧集库 |
| `GET /yingshi?q=<词>&page=<n>` | 仅影视库 |
| `GET /health`                 | 健康检查 |

返回 JAVBUS 认识的格式：

```json
{ "items": [ { "i": "<infoHash>", "t": "<标题>", "s": "<大小>", "d": "<日期>" } ], "total": 173584 }
```

- `q` 为空 → 返回全量并按页浏览（`pageSize` 默认 50）。
- `q` 非空 → 标题子串匹配，按**匹配位置排序**（片名开头命中排最前）。
- JAVBUS 会把 `{query}` 用 `Uri.encodeComponent` 编码后作为 `q` 传入，中文关键词正常。
- `magnet` 不入库，由插件用 `infoHash` 现场拼装 `magnet:?xt=urn:btih:{infoHashUpper}`。

## 目录结构

```
javbus-plugin/
├── javbus-plugin.json          # 合并插件（单一，指向 mg.147771.xyz）
├── edgeone-api/                # EdgeOne Makers 搜索服务
│   ├── server.js               # 零依赖 Node HTTP 服务
│   ├── build_data.js           # 合并 index/ 分片为 data/<type>-all.json
│   ├── package.json
│   ├── .gitignore              # data/ 与 node_modules/ 不入库
│   └── data/                   # 运行时生成的合并索引（被 gitignore，构建期自动生成）
└── index/                      # 静态分片索引（剧集 116 片 / 影视 59 片，每片 1000 条）
    ├── juji/juji-1.json ... juji-116.json
    └── yingshi/yingshi-1.json ... yingshi-59.json
```

## 数据来源与构建

索引来自本地影视磁力清单，拍平后按 `movie[]/tv[] → items[]` 分组，再切成每片 1000 条的分片存入 `index/`。
`edgeone-api/build_data.js` 在部署构建阶段（或本地）把分片合并为 `data/<type>-all.json` 载入内存：

- 优先读本地 `index/`（开发 / 本地有仓库时）；
- 否则从 jsDelivr 镜像拉取 GitHub 仓库分片合并（部署环境无本地 `index/` 时）。

```bash
cd edgeone-api
npm install
npm run build      # 生成 data/juji-all.json + data/yingshi-all.json
node server.js     # 本地起服务（默认 3000 端口）
```

## 部署到自己的 EdgeOne 账号

本项目通过 **EdgeOne Makers** 部署（已连接连接器，登录态由连接器保证，无需手动登录）：

```bash
cd edgeone-api
PAGES_SOURCE=skills edgeone makers deploy -n javbus-search-api --site china --json
```

构建会自动跑 `npm run build` 生成索引，并部署到你的 EdgeOne 账号（控制台可见、可绑自定义域名）。

### 自定义域名（重要）

EdgeOne 默认的 `*.edgeone.cool` 是**预览鉴权域名**（不带 token 返回 401，带 token 需浏览器 SSO 跳转），JAVBUS 插件无法直接调用。要让插件可用，需在 EdgeOne 控制台给项目**绑定自定义域名并完成托管关联**（CNAME 指向项目分配的 EdgeOne 目标），并配置 HTTPS。绑定后该域名公网免鉴权，插件 URL 直接填：

```
https://你的域名/search?q={query}&page={page}
```

本项目自定义域名：`mg.147771.xyz`（已在控制台绑定 + HTTPS）。

## 备注

- 搜索为**标题子串**模糊匹配，输入越精确结果越准；剧集与影视统一返回、按相关性排序。
- 索引更新：改 `index/` 分片后重新部署即可（或本地先 `npm run build`）。
- 数据项仅含 `{i,t,s,d}`，`magnet` 由插件端用 `infoHash` 拼装，不占用索引体积。
