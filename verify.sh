#!/bin/sh
# 一次性 verify：求解器测试（含暴力对照）→ 固定歧义/冲突样例核对 → 生产构建 → HTTP 冒烟。
# 任一步失败立即以非零退出码结束。
set -eu

echo "== 1/4 求解器单元测试（含 300+ 组暴力枚举对照） =="
npm test

echo "== 2/4 固定歧义与冲突样例核对（计数 / 规范补全 / 三项见证） =="
node scripts/verify-samples.mjs

echo "== 3/4 生产构建（Vite） =="
npm run build

echo "== 4/4 HTTP 冒烟（健康路径 + 首页 + 入口资源） =="
node scripts/smoke.mjs

echo ""
echo "verify 全部通过。"
