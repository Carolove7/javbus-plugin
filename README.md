# JAVBUS 私有影视搜索源

把本地影视磁力索引接入 JAVBUS 客户端，作为一个可按关键词**模糊搜索**的私有数据源。

- **数据规模**：173,584 条（剧集 + 影视合并）
- **部署平台**：EdgeOne Makers（Cloud Functions，非常驻服务）
- **公网入口**：`https://mg.147771.xyz`（需自行绑定域名，见文末「部署后必做」）

## 一、安装插件（JAVBUS 客户端）

在「数据源 / JSON 插件」里添加，URL 需以 `.json` 结尾，直接用本仓库 raw 地址：

```
# 合并搜索（剧集 + 影视，走 /search）
https://raw.githubusercontent.com/Carolove7/javbus-plugin/master/ys-plugin.json

# 磁力桥接（走 /mg，桥接 magnet.kiteyuan.info 的 MCP）
https://raw.githubusercontent.com/Carolove7/javbus-plugin/master/mg-plugin.json
```

安装后在搜索框输入**任意部分片名**即可模糊搜索（大小写不敏感、子串匹配）。

## 二、搜索 API

| 端点 | 说明 |
|------|------|
| `GET /search?q=<词>&page=<n>` | 剧集 + 影视合并搜索（ys-plugin.json 用） |
| `GET /mg?q=<词>&page=<n>`     | 桥接 magnet.kiteyuan.info 的 MCP（mg-plugin.json 用） |
| `GET /health`                 | 健康检查 |

返回格式：

```json
{ "items": [ { "i": "<infoHash>", "t": "<标题>", "s": "<大小>", "d": "<日期>" } ], "total": 173584 }
```

- `q` 为空 → 全量按页浏览（默认每页 50）；`q` 非空 → 标题子串匹配，按匹配位置排序。
- `magnet` 不入库，由插件用 `infoHash` 拼装 `magnet:?xt=urn:btih:{infoHashUpper}`。

## 三、目录结构

```
javbus-plugin/                 # 仓库根目录即 Makers 项目根目录
├── ys-plugin.json          # 合并搜索插件（指向 /search）
├── mg-plugin.json          # 磁力桥接插件（指向 /mg）
├── package.json            # Makers 项目；npm run build = 合并 index/ 分片
├── build_data.js           # 合并 index/ 分片 → cloud-functions/_data/
├── .nvmrc                  # Node 20
├── cloud-functions/        # 部署为函数
│   ├── search.js           # → /search
│   ├── health.js           # → /health
│   ├── mg.js               # → /mg
│   ├── index.js            # → /
│   ├── _test_index.mjs     # 倒排索引 vs 全扫描等价性测试（全 PASS）
│   ├── _bench_real.mjs     # 真实数据基准（含内存）
│   └── _data/              # build_data.js 产出（gitignored，不进函数包）
└── index/                  # 静态分片索引（数据源，175 片）
```

> 函数目录必须放在**项目根目录**下，Makers 才会触发 `Node functions build`；否则只产出空静态站、所有路由 404。

## 四、工作原理

- `index/` 是数据源（175 个分片）。运行时从 jsDelivr 拉取分片合并，内存拼成全集（冷启动约 6s，实例复用）。
- 加载期构建 **bigram（二元组）倒排索引**（紧凑 `Int32Array` 存储）：查询先用索引交集收窄候选集，再仅对候选做精确 `indexOf` 校验与「匹配位置」排序。单字查询 / 索引不可用时自动回退全扫描。

### 性能（17.4 万条实测）

| 查询类型 | 全扫描 | bigram 索引 | 加速 |
|----------|--------|-------------|------|
| CJK 双字 | ~7.7 ms | ~0.03 ms | ~220x |
| CJK 三字 | ~7.6 ms | ~0.03 ms | ~254x |
| 英文 SPEED | ~11.5 ms | ~0.1 ms | ~116x |
| 英文 love | ~11.6 ms | ~0.7 ms | ~17x |
| 深页 page=20 | ~7.4 ms | ~0.01 ms | ~512x |
| 无匹配 | ~7.5 ms | ~0.00 ms | ~2000x |
| 单字（回退扫描） | ~7.3 ms | ~7.3 ms | 1.0x |

索引内存开销约 +20MB RSS（全量常驻约 217MB → 建索引后约 237MB）。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `SEARCH_INDEX` | 开启 | 设 `off` 强制全扫描 |
| `SEARCH_INDEX_MAX_MB` | `128` | 倒排表超体积则跳过建索引（内存护栏） |
| `PAGE_SIZE` | `50` | 每页条数 |
| `MG_MCP_TOKEN` | — | `/mg` 需要；`/search` 不需要 |

## 五、部署

### 方式一：原生连接 GitHub（推荐，一键部署）

仓库已置于根目录，平台默认构建配置即可命中函数目录。控制台「项目设置 → 构建部署配置」：

| 配置项 | 值 |
|--------|-----|
| 根目录 | `./` |
| 构建命令 | `npm run build` |
| 输出目录 | `/` |
| Node.js 版本 | `20` |

push 到部署分支即自动部署，也可在控制台点「重新部署」。

### 方式二：本地 / CI 手动部署

```bash
PAGES_SOURCE=skills edgeone makers deploy -n javbus-search-api --json
# 非交互环境（CI）用 -t <token> 代替登录：
edgeone makers deploy -n javbus-search-api -t "$EDGEONE_TOKEN" --json
```

`.github/workflows/deploy.yml` 保留为**手动兜底**（`workflow_dispatch`，不会随 push 自动执行，以免与原生 Git 部署重复触发）。

### 部署后必做

1. **绑定自定义域名**：预览域名 `*.edgeone.cool` 有鉴权墙（无 token → 401；带 token → 302 浏览器 SSO 校验，curl 无法直连）。公网访问需在项目「域名管理」添加 `mg.147771.xyz` 并按给出的 CNAME 值改 DNS。**CLI 没有绑定域名的命令。**
2. **设置环境变量**（项目「环境变量」）：`/search` 无需配置；`/mg` 需要 `MG_MCP_TOKEN`（及 `MG_MCP_URL`），未设置会返回明确错误。
