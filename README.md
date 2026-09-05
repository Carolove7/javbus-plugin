# JAVBUS 私有影视搜索源

把本地影视磁力索引接入 JAVBUS 客户端，作为一个**可按关键词搜索**的私有数据源。

数据规模：剧集 115,409 条 + 影视 58,175 条 = **173,584** 条。

## 安装插件（JAVBUS 客户端）

在「数据源 / JSON 插件」里添加，URL 需以 `.json` 结尾，可直接用本仓库根目录的 raw 地址：

```
# 影视库搜索（剧集 + 影视合并，走 /search）
https://raw.githubusercontent.com/Carolove7/javbus-plugin/master/ys-plugin.json

# 磁力·kiteyuan（经 /mg 桥接调用 magnet.kiteyuan.info 的 MCP，走 /mg）
https://raw.githubusercontent.com/Carolove7/javbus-plugin/master/mg-plugin.json
```

安装后在搜索框输入**任意部分片名**即可模糊搜索（大小写不敏感、子串匹配）。

## 搜索 API

公网地址：`https://mg.147771.xyz`

| 端点 | 说明 |
|------|------|
| `GET /search?q=<词>&page=<n>` | 剧集 + 影视合并搜索（ys-plugin.json 用这个） |
| `GET /mg?q=<词>&page=<n>`     | 经桥接函数调用 magnet.kiteyuan.info 的 MCP（mg-plugin.json 用这个） |
| `GET /health`                 | 健康检查 |

返回格式：

```json
{ "items": [ { "i": "<infoHash>", "t": "<标题>", "s": "<大小>", "d": "<日期>" } ], "total": 173584 }
```

- `q` 为空 → 返回全量按页浏览（`pageSize` 默认 50）；`q` 非空 → 标题子串匹配，按匹配位置排序。
- `magnet` 不入库，由插件用 `infoHash` 拼装 `magnet:?xt=urn:btih:{infoHashUpper}`。

## 目录结构

```
javbus-plugin/                 # ← 仓库根目录即 Makers 项目根目录（便于原生 Git 部署）
├── ys-plugin.json          # 合并插件（指向 mg.147771.xyz）
├── mg-plugin.json          # 磁力·kiteyuan 桥接插件（走 /mg）
├── package.json            # Makers 项目；npm run build = 合并 index/ 分片
├── build_data.js           # 合并 index/ 分片 → cloud-functions/_data/
├── cloud-functions/        # 部署为函数：search.js→/search, health.js→/health, mg.js→/mg, index.js→/
│   ├── _test_search.mjs    # 搜索契约测试
│   ├── _test_index.mjs     # 倒排索引等价性测试
│   ├── _bench_search.mjs   # 合成数据基准
│   ├── _bench_real.mjs     # 真实数据基准（含内存）
│   └── _data/              # build_data.js 产出（gitignored；不进函数包）
└── index/                  # 静态分片索引（剧集 116 / 影视 59 片，每片 1000 条）
```

> **为什么项目放在仓库根目录**：Makers 在「项目根目录」下寻找 `cloud-functions/` 才会触发
> `Node functions build`。放在子目录里时，远端构建按默认根目录执行会找不到函数目录，
> 只产出空静态站导致所有路由 404。详见下方「部署」。

## 工作原理

- `index/` 存 175 个分片（剧集 + 影视），是数据源。
- EdgeOne Makers 部署的是 **Cloud Functions**（`cloud-functions/` 下的 `onRequest*` handler），不是常驻服务。
- 函数运行时先尝试读随代码包部署的 `_data/` 分片（`all-1..N.json` + `all-meta.json`）；但**构建不会把 `cloud-functions/_data/` 打进函数包**（只打 `.js` handler + `node_modules`），因此实际走兜底：从 jsDelivr 拉取 `index/` 分片合并，在内存中拼成全集（冷启动约 6s，之后实例缓存复用）。
- 加载期一次性构建 **bigram（二元组）倒排索引**（紧凑 `Int32Array` 存储）：查询时先用索引交集收窄候选集，再仅对候选做精确 `indexOf` 校验与「匹配位置」排序。搜索仍为标题大小写不敏感子串模糊匹配，剧集与影视统一返回；单字查询与索引不可用时自动回退全扫描。

### 性能（实测，17.4 万条）

| 查询类型 | 全扫描 | bigram 索引 | 加速 |
|----------|--------|-------------|------|
| CJK 双字「速度」 | ~7.7 ms | ~0.03 ms | ~220x |
| CJK 三字「速度与激情」 | ~7.6 ms | ~0.03 ms | ~254x |
| 英文「SPEED」 | ~11.5 ms | ~0.1 ms | ~116x |
| 英文「love」 | ~11.6 ms | ~0.7 ms | ~17x |
| 罕见长串 | ~9.0 ms | ~0.09 ms | ~105x |
| 深页（page=20） | ~7.4 ms | ~0.01 ms | ~512x |
| 无匹配 | ~7.5 ms | ~0.00 ms | ~2000x |
| 单字「速」（回退扫描） | ~7.3 ms | ~7.3 ms | 1.0x |

索引内存开销：约 +20MB RSS（全量数据常驻约 217MB，建索引后约 237MB）。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SEARCH_INDEX` | 开启 | 设为 `off` 关闭倒排索引，强制全扫描 |
| `SEARCH_INDEX_MAX_MB` | `128` | 倒排表预估超过该体积则跳过建索引（内存护栏） |
| `PAGE_SIZE` | `50` | 每页条数 |

## 部署

### 方式一：原生连接 GitHub 仓库（推荐，一键部署）

项目已迁至**仓库根目录**，因此平台默认构建配置即可命中函数目录，无需额外设置。

控制台「项目设置 → 构建部署配置」建议值：

| 配置项 | 值 |
|--------|-----|
| 根目录 | `./`（默认即可） |
| 构建命令 | `npm run build` |
| 输出目录 | `/`（默认即可） |
| Node.js 版本 | `20`（仓库已带 `.nvmrc`） |

配置好后，**push 到部署分支即自动部署**，也可以在控制台点「重新部署」。

> 关键点：Makers 是在**项目根目录**下寻找 `cloud-functions/` 才会触发 `Node functions build`
> （把 `cloud-functions/*.js` 打包进 `.edgeone/cloud-functions/api-node/index.mjs`）。
> 根目录里必须有 `package.json` 和 `cloud-functions/`，二者缺一就只会产出空静态站 → 全部路由 404。

### 方式二：本地 / CI 手动部署

```bash
PAGES_SOURCE=skills edgeone makers deploy -n javbus-search-api --json
```

非交互环境（CI）用 `-t <token>` 代替登录：

```bash
edgeone makers deploy -n javbus-search-api -t "$EDGEONE_TOKEN" --json
```

`.github/workflows/deploy.yml` 保留为**手动兜底**（`workflow_dispatch`，不会随 push 自动执行，
以免与原生 Git 部署重复触发）。若用不到可直接删除。

### 部署后必做

1. **绑定自定义域名**：预览域名 `*.edgeone.cool` 有鉴权墙（无 token → 401；带 token → 302 浏览器 SSO 校验，curl 无法直连）。
   公网访问必须在项目「域名管理」添加自定义域名（如 `mg.147771.xyz`）并按给出的 CNAME 值改 DNS。**CLI 没有绑定域名的命令。**
2. **设置环境变量**（项目「环境变量」）：`/search` 无需配置；`/mg` 需要 `MG_MCP_TOKEN`（及 `MG_MCP_URL`），未设置会返回明确错误。
