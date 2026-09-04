# JAVBUS 私有影视搜索源

把本地影视磁力索引接入 JAVBUS 客户端，作为一个**可按关键词搜索**的私有数据源。

数据规模：剧集 115,409 条 + 影视 58,175 条 = **173,584** 条。

## 安装插件（JAVBUS 客户端）

在「数据源 / JSON 插件」里添加，URL 填：

```
https://raw.githubusercontent.com/Carolove7/javbus-juji-plugin/master/javbus-plugin.json
```

安装后在搜索框输入**任意部分片名**即可模糊搜索（大小写不敏感、子串匹配）。

## 搜索 API

公网地址：`https://mg.147771.xyz`

| 端点 | 说明 |
|------|------|
| `GET /search?q=<词>&page=<n>` | 剧集 + 影视合并搜索（插件用这个） |
| `GET /health`                 | 健康检查 |

返回格式：

```json
{ "items": [ { "i": "<infoHash>", "t": "<标题>", "s": "<大小>", "d": "<日期>" } ], "total": 173584 }
```

- `q` 为空 → 返回全量按页浏览（`pageSize` 默认 50）；`q` 非空 → 标题子串匹配，按匹配位置排序。
- `magnet` 不入库，由插件用 `infoHash` 拼装 `magnet:?xt=urn:btih:{infoHashUpper}`。

## 目录结构

```
javbus-plugin/
├── javbus-plugin.json      # 合并插件（指向 mg.147771.xyz）
├── edgeone-api/            # EdgeOne Makers 搜索服务（Cloud Functions）
│   ├── cloud-functions/    # 部署为函数：search.js→/search, health.js→/health, index.js→/
│   ├── build_data.js       # 合并 index/ 分片
│   └── package.json
└── index/                 # 静态分片索引（剧集 116 / 影视 59 片，每片 1000 条）
```

## 工作原理

- `index/` 存 175 个分片（剧集 + 影视），是数据源。
- EdgeOne Makers 部署的是 **Cloud Functions**（`cloud-functions/` 下的 `onRequest*` handler），不是常驻服务。
- 函数运行时从 jsDelivr 拉取 `index/` 分片，在内存中拼成全集（冷启动约 6s，之后实例缓存复用）；搜索为标题子串模糊匹配，剧集与影视统一返回。

## 部署

```bash
cd edgeone-api
PAGES_SOURCE=skills edgeone makers deploy -n javbus-search-api --json
```
