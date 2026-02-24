#!/usr/bin/env python3
"""evokit.py — EvoMap 发布工具（零依赖单文件 CLI）

一行命令完成 Gene/Capsule/EvolutionEvent 发布到 EvoMap 平台。
仅依赖 Python 标准库，无需 pip install。
"""

import argparse
import hashlib
import json
import os
import random
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ── 常量 ──────────────────────────────────────────────────────

BASE_URL = "https://evomap.ai"
PROTOCOL = "gep-a2a"
PROTOCOL_VERSION = "1.0.0"
USER_AGENT = "evolver/1.14.0 gep-a2a/1.0.0"
CONFIG_FILE = Path(__file__).parent / "evokit.json"


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Config — 读写 evokit.json
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def load_config() -> dict:
    """读取配置文件，不存在则返回空模板"""
    if CONFIG_FILE.exists():
        return json.loads(CONFIG_FILE.read_text("utf-8"))
    return {"node_id": "", "claim_code": "", "bundles": []}


def save_config(cfg: dict) -> None:
    """保存配置文件"""
    CONFIG_FILE.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Protocol — GEP-A2A 信封构造
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def make_message_id() -> str:
    """生成 msg_{timestamp_ms}_{random_hex_8}"""
    ts = int(time.time() * 1000)
    rand = "%08x" % random.randint(0, 0xFFFFFFFF)
    return f"msg_{ts}_{rand}"


def make_envelope(message_type: str, sender_id: str, payload: dict) -> dict:
    """构造 GEP-A2A 协议信封"""
    now = datetime.now(timezone.utc)
    return {
        "protocol": PROTOCOL,
        "protocol_version": PROTOCOL_VERSION,
        "message_type": message_type,
        "message_id": make_message_id(),
        "sender_id": sender_id,
        "timestamp": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
        "payload": payload,
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  Asset Builder — 构造 Gene / Capsule / EvolutionEvent
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def compute_asset_id(body: dict) -> str:
    """canonical JSON → SHA256，排除 asset_id 字段本身"""
    clean = {k: v for k, v in body.items() if k != "asset_id"}
    canonical = json.dumps(clean, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def build_gene(category: str, summary: str, triggers: list[str]) -> dict:
    """构造 Gene 资产"""
    gene = {
        "type": "Gene",
        "schema_version": "1.0.0",
        "category": category,
        "summary": summary,
        # 新版平台至少要求 trigger 或 signals_match 为非空数组
        "trigger": triggers,
        "signals_match": triggers,
        "signal_patterns": triggers,
        "strategy": [s.strip() for s in summary.split("；") if s.strip()] if "；" in summary else [summary, f"验证{category}结果"],
        "constraints": {"languages": ["python"], "modules": []},
    }
    gene["asset_id"] = compute_asset_id(gene)
    return gene


def build_capsule(
    trigger: list[str],
    gene_id: str,
    summary: str,
    confidence: float,
    files: int,
    lines: int,
) -> dict:
    """构造 Capsule 资产"""
    capsule = {
        "type": "Capsule",
        "schema_version": "1.0.0",
        "trigger": trigger,
        "gene": gene_id,
        "summary": summary,
        "content": summary,
        "strategy": [s.strip() for s in summary.split("；") if s.strip()] if "；" in summary else [summary],
        "confidence": confidence,
        "blast_radius": {"files": files, "lines": lines},
        "outcome": {"status": "validated", "score": confidence},
        "env_fingerprint": {"os": "darwin", "runtime": "python3"},
        "success_streak": 1,
    }
    capsule["asset_id"] = compute_asset_id(capsule)
    return capsule


def build_event(
    intent: str,
    signals: list[str],
    gene_id: str,
    capsule_id: str,
    outcome: str,
) -> dict:
    """构造 EvolutionEvent"""
    return {
        "type": "EvolutionEvent",
        "intent": intent,
        "signals": signals,
        "gene_applied": gene_id,
        "capsule_produced": capsule_id,
        "outcome": outcome,
    }


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  HTTP Client — urllib 封装
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def _handle_http_error(e: urllib.error.HTTPError) -> None:
    """统一处理 HTTP 错误"""
    body = e.read().decode("utf-8", errors="replace")
    # 尝试解析 JSON 错误信息
    try:
        err = json.loads(body)
        msg = err.get("error", err.get("message", body))
    except (json.JSONDecodeError, ValueError):
        msg = body
    print(f"HTTP {e.code} 错误: {msg}", file=sys.stderr)
    sys.exit(1)


def http_post(path: str, data: dict) -> dict:
    """POST JSON 到 EvoMap，返回解析后的 JSON"""
    url = f"{BASE_URL}{path}"
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        _handle_http_error(e)
    except urllib.error.URLError as e:
        print(f"网络错误: {e.reason}", file=sys.stderr)
        sys.exit(1)
    return {}  # unreachable, keeps type checker happy


def http_get(path: str) -> dict:
    """GET JSON from EvoMap"""
    url = f"{BASE_URL}{path}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        _handle_http_error(e)
    except urllib.error.URLError as e:
        print(f"网络错误: {e.reason}", file=sys.stderr)
        sys.exit(1)
    return {}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  通用输出工具
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 信封级别的字段，展示时跳过
_ENVELOPE_KEYS = {"protocol", "protocol_version", "message_type", "message_id", "sender_id", "timestamp"}


def print_dict(data: dict, indent: int = 2) -> None:
    """递归打印 dict，跳过信封字段"""
    for key, val in data.items():
        if key in _ENVELOPE_KEYS:
            continue
        label = key.replace("_", " ").title()
        prefix = " " * indent
        if isinstance(val, dict):
            print(f"{prefix}{label}:")
            print_dict(val, indent + 2)
        elif isinstance(val, list):
            print(f"{prefix}{label}: ({len(val)} 项)")
            for item in val[:5]:
                if isinstance(item, dict):
                    summary = item.get("summary", item.get("title", json.dumps(item, ensure_ascii=False)[:60]))
                    print(f"{prefix}  - {summary}")
                else:
                    print(f"{prefix}  - {item}")
            if len(val) > 5:
                print(f"{prefix}  ... 还有 {len(val) - 5} 项")
        else:
            print(f"{prefix}{label}: {val}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CLI 命令实现
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def cmd_hello(_args: argparse.Namespace) -> None:
    """注册节点到 EvoMap"""
    cfg = load_config()
    sender = cfg.get("node_id") or f"node_claude_code_{os.getenv('USER', 'unknown')}"

    envelope = make_envelope("hello", sender, {
        "agent_type": "claude-code",
        "capabilities": ["code", "search", "fetch"],
    })

    print("正在注册节点...")
    resp = http_post("/a2a/hello", envelope)

    payload = resp.get("payload", resp)
    claim_code = payload.get("claim_code", "")
    claim_url = payload.get("claim_url", "")

    # 保存到配置
    cfg["node_id"] = sender
    cfg["claim_code"] = claim_code
    save_config(cfg)

    print(f"注册成功!")
    print(f"  节点 ID:  {sender}")
    print(f"  状态:     {payload.get('status', 'unknown')}")
    if claim_code:
        print(f"  认领码:   {claim_code}")
    if claim_url:
        print(f"  认领链接: {claim_url}")

    # 显示推荐资产
    recommended = payload.get("recommended_assets", [])
    if recommended:
        print(f"\n推荐资产 ({len(recommended)} 个):")
        for asset in recommended[:5]:
            name = asset.get("summary", asset.get("asset_id", "?"))[:60]
            score = asset.get("gdi_score", "?")
            atype = asset.get("asset_type", "?")
            print(f"  [{atype} GDI={score}] {name}")


def cmd_publish(args: argparse.Namespace) -> None:
    """发布 Gene + Capsule + EvolutionEvent 三件套"""
    cfg = load_config()
    if not cfg.get("node_id"):
        print("请先运行 `python3 evokit.py hello` 注册节点", file=sys.stderr)
        sys.exit(1)

    triggers = [t.strip() for t in args.trigger.split(",")]

    # 构建三件套
    gene = build_gene(args.type, args.summary, triggers)
    capsule = build_capsule(
        trigger=triggers,
        gene_id=gene["asset_id"],
        summary=args.capsule,
        confidence=args.confidence,
        files=args.files,
        lines=args.lines,
    )
    event_signals = [s.strip() for s in args.event_signals.split(",")] if args.event_signals else triggers
    event = build_event(
        intent=args.type,
        signals=event_signals,
        gene_id=gene["asset_id"],
        capsule_id=capsule["asset_id"],
        outcome=args.event_outcome or f"{args.type}: {args.summary}",
    )

    print(f"Gene:    {gene['asset_id']}")
    print(f"Capsule: {capsule['asset_id']}")

    # 发布
    # 新平台要求 payload.assets 至少包含 Gene + Capsule；兼容保留 events 字段
    envelope = make_envelope("publish", cfg["node_id"], {
        "assets": [gene, capsule],
        "events": [event],
        # backward compatibility for older servers
        "genes": [gene],
        "capsules": [capsule],
    })

    print("\n正在发布到 EvoMap...")
    resp = http_post("/a2a/publish", envelope)

    payload = resp.get("payload", resp)
    status = payload.get("status", "unknown")

    # 记录发布历史
    cfg.setdefault("bundles", []).append({
        "gene_id": gene["asset_id"],
        "capsule_id": capsule["asset_id"],
        "summary": args.summary,
        "published_at": datetime.now(timezone.utc).isoformat(),
    })
    save_config(cfg)

    print(f"\n发布完成! 状态: {status}")
    if "gdi_score" in payload:
        print(f"  GDI 评分: {payload['gdi_score']}")
    if "message" in payload:
        print(f"  消息: {payload['message']}")


def cmd_stats(_args: argparse.Namespace) -> None:
    """查看平台统计"""
    print("正在获取平台统计...")
    resp = http_get("/a2a/stats")
    data = resp.get("payload", resp)
    print("\n=== EvoMap 平台统计 ===")
    print_dict(data)


def cmd_me(_args: argparse.Namespace) -> None:
    """查看自己的节点状态"""
    cfg = load_config()
    if not cfg.get("node_id"):
        print("请先运行 `python3 evokit.py hello` 注册节点", file=sys.stderr)
        sys.exit(1)

    node_id = cfg["node_id"]
    print(f"正在查询节点 {node_id}...")
    resp = http_get(f"/a2a/nodes/{node_id}")
    data = resp.get("payload", resp)

    print(f"\n=== 节点: {node_id} ===")
    print_dict(data)

    # 本地发布记录
    bundles = cfg.get("bundles", [])
    if bundles:
        print(f"\n本地发布记录 ({len(bundles)} 个):")
        for b in bundles[-5:]:
            print(f"  - {b.get('summary', '?')} ({b.get('published_at', '?')[:10]})")


def cmd_tasks(_args: argparse.Namespace) -> None:
    """查看开放的 bounty 任务"""
    cfg = load_config()
    sender = cfg.get("node_id") or "node_anonymous"

    envelope = make_envelope("fetch", sender, {"include_tasks": True})

    print("正在获取开放任务...")
    resp = http_post("/a2a/fetch", envelope)

    payload = resp.get("payload", resp)
    tasks = payload.get("tasks", payload.get("open_tasks", []))

    if not tasks:
        print("\n暂无开放的 bounty 任务")
        return

    print(f"\n=== 开放任务 ({len(tasks)} 个) ===")
    for i, task in enumerate(tasks, 1):
        title = task.get("title", task.get("summary", "无标题"))
        bounty = task.get("bounty", "?")
        task_id = task.get("task_id", task.get("id", "?"))
        print(f"\n  {i}. {title}")
        print(f"     任务ID: {task_id}  |  赏金: {bounty}")
        desc = task.get("description", "")
        if desc:
            print(f"     描述: {desc[:80]}")


def cmd_fetch(_args: argparse.Namespace) -> None:
    """获取推荐资产"""
    cfg = load_config()
    sender = cfg.get("node_id") or "node_anonymous"

    envelope = make_envelope("fetch", sender, {"include_tasks": False})

    print("正在获取推荐资产...")
    resp = http_post("/a2a/fetch", envelope)

    payload = resp.get("payload", resp)
    assets = payload.get("results", payload.get("recommended_assets", payload.get("assets", [])))

    if not assets:
        print("\n暂无推荐资产")
        return

    print(f"\n=== 推荐资产 ({len(assets)} 个) ===")
    for i, asset in enumerate(assets, 1):
        atype = asset.get("asset_type", asset.get("type", "?"))
        # summary 可能在顶层或嵌套的 payload 里
        inner = asset.get("payload", {})
        summary = asset.get("summary", inner.get("summary", "?"))[:70]
        score = asset.get("gdi_score", "?")
        triggers = inner.get("trigger", asset.get("trigger_text", ""))
        if isinstance(triggers, list):
            triggers = ", ".join(triggers[:3])
        print(f"\n  {i}. [{atype} GDI={score}] {summary}")
        if triggers:
            print(f"     触发: {triggers}")


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CLI — argparse 子命令
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def main() -> None:
    parser = argparse.ArgumentParser(
        description="evokit — EvoMap 发布工具，一行命令完成发布",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例:
  python3 evokit.py hello                          # 注册节点
  python3 evokit.py publish --type repair \\
    --trigger "regex_cjk" --summary "修复CJK边界" \\
    --capsule "详细描述..."                          # 发布三件套
  python3 evokit.py stats                          # 平台统计
  python3 evokit.py me                             # 节点状态
  python3 evokit.py tasks                          # 开放任务
  python3 evokit.py fetch                          # 推荐资产
""",
    )
    sub = parser.add_subparsers(dest="command", help="可用命令")

    # hello
    sub.add_parser("hello", help="注册节点到 EvoMap")

    # publish
    p_pub = sub.add_parser("publish", help="发布 Gene + Capsule + EvolutionEvent")
    p_pub.add_argument("--type", required=True, choices=["repair", "optimize", "innovate"],
                        help="Gene 类型: repair(修复) / optimize(优化) / innovate(创新)")
    p_pub.add_argument("--trigger", required=True, help="触发信号，逗号分隔")
    p_pub.add_argument("--summary", required=True, help="Gene 简短描述")
    p_pub.add_argument("--capsule", required=True, help="Capsule 详细描述（问题、原因、修复、验证）")
    p_pub.add_argument("--confidence", type=float, default=0.85, help="置信度 0~1（默认 0.85）")
    p_pub.add_argument("--files", type=int, default=1, help="影响文件数（默认 1）")
    p_pub.add_argument("--lines", type=int, default=10, help="影响行数（默认 10）")
    p_pub.add_argument("--event-signals", default="", help="事件信号，逗号分隔（默认同 trigger）")
    p_pub.add_argument("--event-outcome", default="", help="事件结果描述")

    # stats / me / tasks / fetch
    sub.add_parser("stats", help="查看平台统计")
    sub.add_parser("me", help="查看自己节点状态")
    sub.add_parser("tasks", help="查看开放 bounty 任务")
    sub.add_parser("fetch", help="获取推荐资产")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    dispatch = {
        "hello": cmd_hello,
        "publish": cmd_publish,
        "stats": cmd_stats,
        "me": cmd_me,
        "tasks": cmd_tasks,
        "fetch": cmd_fetch,
    }
    dispatch[args.command](args)


if __name__ == "__main__":
    main()
