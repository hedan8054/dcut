#!/bin/bash
# LiveCuts v1.2 一键启动脚本

set -e
cd "$(dirname "$0")"

echo "=== LiveCuts v1.2 ==="

# 创建数据目录
mkdir -p data/{snapshots,frames,sku_images,thumbnails}

# 选择可用 Python（优先 Homebrew 版本，避免缺少依赖）
if [ -x /opt/homebrew/bin/python3.14 ]; then
    PY_BIN=/opt/homebrew/bin/python3.14
else
    PY_BIN=python3
fi

# 停止旧进程
echo "清理旧进程..."
lsof -ti:8421 | xargs kill -9 2>/dev/null || true
lsof -ti:5181 | xargs kill -9 2>/dev/null || true
sleep 1

# 启动后端
echo "启动后端 (port 8421)..."
$PY_BIN -m uvicorn backend.main:app --host 0.0.0.0 --port 8421 &
BACKEND_PID=$!
sleep 2

# 验证后端
if curl -s http://localhost:8421/api/health | grep -q ok; then
    echo "  后端启动成功"
else
    echo "  后端启动失败!"
    exit 1
fi

# 启动前端
echo "启动前端 (port 5181)..."
cd frontend
npx vite --port 5181 &
FRONTEND_PID=$!
cd ..
sleep 2

echo ""
echo "=== 启动完成 ==="
echo "前端: http://localhost:5181"
echo "后端: http://localhost:8421"
echo "API文档: http://localhost:8421/docs"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待子进程
wait
