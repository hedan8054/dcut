"""pytest 全局配置"""
import sys
from pathlib import Path

# 确保 backend 目录在 Python 路径中
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
