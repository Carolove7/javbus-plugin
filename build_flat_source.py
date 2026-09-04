#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 OpenList 上的 剧集.json（嵌套 movie[]/tv[] -> items[]）拍平成
JAVBUS 友好的扁平结构：{ updated, total, items: [...] }

用法:
  python build_flat_source.py 剧集.json -o 剧集-index.json

也可直接从 URL 拉取（需可公开访问）:
  python build_flat_source.py https://op.147771.xyz/d/file/%E5%89%A7%E9%9B%86.json -o 剧集-index.json

输出字段（已对齐 JAVBUS 内部字段名，适配器/插件可直接 1:1 映射）:
  sourceItemId  稳定 ID（优先用 btih，否则用 title 的 sha1 前 16 位）
  title         资源标题
  remarks       剧名备注
  tags          标签数组
  infoHash      magnet 里的 btih（大写，40 位）
  magnet        磁力链接
  humanSize     可读大小（如 12.92GB）
  createdAt     创建时间
  type          movie / tv
  webUrl        详情链接（这里直接用 magnet）
"""
import json
import re
import sys
import hashlib
import argparse
import urllib.request


def parse_infohash(magnet):
    if not magnet:
        return None
    m = re.search(r'urn:btih:([A-Fa-f0-9]{32,40})', magnet)
    return m.group(1).upper() if m else None


def flatten(data):
    items = []
    for kind in ('movie', 'tv'):
        for entry in data.get(kind, []) or []:
            remarks = entry.get('remarks', '')
            tags = entry.get('tags', []) or []
            for it in entry.get('items', []) or []:
                title = it.get('title', '')
                link = it.get('link', '')
                ih = parse_infohash(link)
                sid = ih or hashlib.sha1(title.encode('utf-8')).hexdigest()[:16].upper()
                items.append({
                    "sourceItemId": sid,
                    "title": title,
                    "remarks": remarks,
                    "tags": tags,
                    "infoHash": ih or "",
                    "magnet": link,
                    "humanSize": it.get('size', ''),
                    "createdAt": it.get('create_time', ''),
                    "type": kind,
                    "webUrl": link,
                })
    return items


def load_input(path):
    if path.startswith('http://') or path.startswith('https://'):
        req = urllib.request.Request(path, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode('utf-8'))
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='剧集.json 本地路径或 URL')
    ap.add_argument('-o', '--output', default='剧集-index.json')
    args = ap.parse_args()

    data = load_input(args.input)
    items = flatten(data)
    out = {"updated": data.get('updated', ''), "total": len(items), "items": items}
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"拍平完成: {len(items)} 条 -> {args.output}")


if __name__ == '__main__':
    main()
