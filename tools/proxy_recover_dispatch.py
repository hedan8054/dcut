#!/usr/bin/env python3
"""分布式坏代理恢复调度器。

把 bad 列表按机器分片，通过 SSH 触发远端执行 proxy_recover_one.py。
每个远端一次只跑 1 个视频（串行），防止内存/IO 打爆。

用法:
    python3 tools/proxy_recover_dispatch.py \
        --db data/livecuts.db \
        --bad-ids 115,40,111,69,5,45,75,46,31,4,23 \
        --artifacts-dir docs/meeting-room/.../artifacts

分片策略：按 duration 交替分配，使两台机器负载大致均衡。
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ─── 远端配置 ────────────────────────────────────────
NODES = {
    "a1502": {
        "ssh_cmd": "sshpass -p 'ZXCVBN' ssh -o StrictHostKeyChecking=no dd2013@192.168.2.160",
        "ffmpeg": "/usr/local/bin/ffmpeg",
        "ffprobe": "/usr/local/bin/ffprobe",
        "nas_prefix": "/Volumes/切片",
        "proxy_dir": "/Volumes/切片/proxy",
        "python": "python3",
        "script_path": "/tmp/proxy_recover_one.py",
    },
    "windows": {
        "ssh_cmd": "ssh Administrator@192.168.2.246",
        "ffmpeg": r"C:\ffmpeg\ffmpeg-8.0.1-essentials_build\bin\ffmpeg.exe",
        "ffprobe": r"C:\ffmpeg\ffmpeg-8.0.1-essentials_build\bin\ffprobe.exe",
        "nas_prefix": "Z:",
        "proxy_dir": r"Z:\proxy",
        "python": r'"C:\Program Files\Python312\python.exe"',
        "script_path": r"C:\proxy_recover_one.py",
        "pre_cmd": r"net use Z: \\192.168.2.91\切片 /user:marshe 1QAW3edr5 2>nul",
    },
}


def load_bad_videos(db_path: str, bad_ids: list[int]) -> list[dict]:
    """从 DB 读取 bad 视频的元数据"""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    result = []
    for vid in bad_ids:
        row = conn.execute(
            "SELECT id, session_date, session_label, duration_sec FROM video_registry WHERE id = ?",
            (vid,),
        ).fetchone()
        if not row:
            print(f"[warn] vid={vid} not found in DB, skipping")
            continue
        segs = conn.execute(
            "SELECT raw_path FROM video_segments WHERE video_id = ? ORDER BY segment_index",
            (vid,),
        ).fetchall()
        label = (row["session_label"] or "main").replace("/", "-").replace("\\", "-")
        result.append({
            "video_id": row["id"],
            "session_date": row["session_date"],
            "session_label": row["session_label"],
            "duration_sec": float(row["duration_sec"] or 0),
            "proxy_name": f"{row['session_date']}_{label}.mp4",
            "segments": [s["raw_path"] for s in segs],
        })
    conn.close()
    return sorted(result, key=lambda x: x["duration_sec"])


def remap_path(path: str, from_prefix: str, to_prefix: str) -> str:
    """路径前缀映射（Mac NAS → Windows Z:）"""
    if path.startswith(from_prefix):
        rest = path[len(from_prefix):]
        if to_prefix.endswith(":"):
            # Windows: /衣甜/... → Z:\衣甜\...
            return to_prefix + rest.replace("/", "\\")
        return to_prefix + rest
    return path


def scp_script(node_key: str) -> bool:
    """把 proxy_recover_one.py 推送到远端"""
    node = NODES[node_key]
    local = os.path.join(os.path.dirname(__file__), "proxy_recover_one.py")
    target = node["script_path"]

    if node_key == "windows":
        # Windows: scp 路径需要用 / 而非 \
        scp_target = target.replace("\\", "/")
        cmd = f'scp -o StrictHostKeyChecking=no "{local}" Administrator@192.168.2.246:{scp_target}'
    else:
        cmd = f"sshpass -p 'ZXCVBN' scp -o StrictHostKeyChecking=no '{local}' dd2013@192.168.2.160:{target}"

    print(f"[scp] {node_key}: {local} → {target}", flush=True)
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        print(f"[scp] FAILED: {r.stderr}", flush=True)
        return False
    return True


def _build_remote_script(node_key: str, node: dict, video: dict, remote_output: str) -> str:
    """构建远端执行的脚本内容（避免 SSH 嵌套引号问题）"""
    mac_prefix = "/Volumes/切片"
    remote_prefix = node["nas_prefix"]
    remote_segs = [remap_path(s, mac_prefix, remote_prefix) for s in video["segments"]]

    if node_key == "windows":
        # Windows batch script
        lines = ["@echo off"]
        pre = node.get("pre_cmd", "")
        if pre:
            lines.append(pre)
        seg_args = " ".join(f'"{s}"' for s in remote_segs)
        lines.append(
            f'"{node["python"].strip(chr(34))}" {node["script_path"]}'
            f' --video-id {video["video_id"]}'
            f' --db /dev/null'
            f' --ffmpeg "{node["ffmpeg"]}"'
            f' --ffprobe "{node.get("ffprobe", "ffprobe")}"'
            f' --nas-prefix "{remote_prefix}"'
            f' --proxy-dir "{node["proxy_dir"]}"'
            f' --expected-duration {video["duration_sec"]}'
            f' --proxy-name "{video["proxy_name"]}"'
            f' --output "{remote_output}"'
            f' --segments {seg_args}'
        )
        return "\r\n".join(lines) + "\r\n"
    else:
        # Bash script
        lines = ["#!/bin/bash", "set -e"]
        seg_args = " ".join(f"'{s}'" for s in remote_segs)
        lines.append(
            f'{node["python"]} {node["script_path"]}'
            f' --video-id {video["video_id"]}'
            f' --db /dev/null'
            f" --ffmpeg '{node['ffmpeg']}'"
            f" --ffprobe '{node.get('ffprobe', 'ffprobe')}'"
            f" --nas-prefix '{remote_prefix}'"
            f" --proxy-dir '{node['proxy_dir']}'"
            f' --expected-duration {video["duration_sec"]}'
            f" --proxy-name '{video['proxy_name']}'"
            f" --output '{remote_output}'"
            f' --segments {seg_args}'
        )
        return "\n".join(lines) + "\n"


def _clean_env() -> dict:
    """返回清除代理的环境变量"""
    env = dict(os.environ)
    for k in ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]:
        env.pop(k, None)
    return env


def run_remote(node_key: str, video: dict, output_path: str) -> dict:
    """在远端执行 proxy_recover_one.py 并收集结果

    策略：先把命令写成脚本文件推到远端执行，避免 SSH 嵌套引号问题。
    """
    node = NODES[node_key]
    vid = video["video_id"]
    env = _clean_env()

    remote_output = f"/tmp/recover_vid{vid}.json" if node_key != "windows" else f"C:\\recover_vid{vid}.json"
    script_content = _build_remote_script(node_key, node, video, remote_output)

    # 写本地临时脚本
    suffix = ".cmd" if node_key == "windows" else ".sh"
    local_script = os.path.join(tempfile.gettempdir(), f"recover_vid{vid}{suffix}")
    Path(local_script).write_text(script_content, encoding="utf-8")

    remote_script = f"C:\\recover_vid{vid}.cmd" if node_key == "windows" else f"/tmp/recover_vid{vid}.sh"

    # 推送脚本
    if node_key == "windows":
        scp_cmd = f'scp -o StrictHostKeyChecking=no "{local_script}" Administrator@192.168.2.246:{remote_script.replace(chr(92), "/")}'
    else:
        scp_cmd = f"sshpass -p 'ZXCVBN' scp -o StrictHostKeyChecking=no '{local_script}' dd2013@192.168.2.160:{remote_script}"
    subprocess.run(scp_cmd, shell=True, capture_output=True, env=env, timeout=30)

    # 执行远端脚本
    if node_key == "windows":
        ssh_cmd = f'ssh -o ConnectTimeout=10 Administrator@192.168.2.246 "{remote_script}"'
    else:
        ssh_cmd = f"sshpass -p 'ZXCVBN' ssh -o StrictHostKeyChecking=no dd2013@192.168.2.160 'bash {remote_script}'"

    print(f"\n[dispatch] vid={vid} → {node_key} (duration={video['duration_sec']:.0f}s, segs={len(video['segments'])})", flush=True)
    t0 = time.time()

    try:
        proc = subprocess.run(ssh_cmd, shell=True, capture_output=True, text=True,
                              timeout=14400, env=env)
        elapsed = round(time.time() - t0, 1)

        # 打印远端 stdout（进度信息）
        if proc.stdout:
            for line in proc.stdout.strip().split("\n")[-5:]:
                print(f"  [{node_key}] {line}", flush=True)
        if proc.returncode != 0 and proc.stderr:
            print(f"  [{node_key}] stderr: {proc.stderr[-200:]}", flush=True)

        # 拉取结果 JSON
        if node_key == "windows":
            fetch_cmd = f'scp -o StrictHostKeyChecking=no Administrator@192.168.2.246:{remote_output.replace(chr(92), "/")} "{output_path}"'
        else:
            fetch_cmd = f"sshpass -p 'ZXCVBN' scp -o StrictHostKeyChecking=no dd2013@192.168.2.160:{remote_output} '{output_path}'"

        fr = subprocess.run(fetch_cmd, shell=True, capture_output=True, text=True, timeout=30, env=env)

        if fr.returncode == 0 and Path(output_path).exists():
            result = json.loads(Path(output_path).read_text())
            result["node"] = node_key
            result["elapsed_sec"] = elapsed
            Path(output_path).write_text(json.dumps(result, indent=2, ensure_ascii=False))
            return result
        else:
            return {
                "video_id": vid,
                "ok": False,
                "node": node_key,
                "error": f"scp fetch failed (rc={fr.returncode}); ssh rc={proc.returncode}; stderr: {proc.stderr[-300:]}",
                "elapsed_sec": elapsed,
            }
    except subprocess.TimeoutExpired:
        return {
            "video_id": vid,
            "ok": False,
            "node": node_key,
            "error": "timeout (>4h)",
            "elapsed_sec": round(time.time() - t0, 1),
        }
    except Exception as exc:
        return {
            "video_id": vid,
            "ok": False,
            "node": node_key,
            "error": str(exc)[:500],
            "elapsed_sec": round(time.time() - t0, 1),
        }
    finally:
        Path(local_script).unlink(missing_ok=True)


def split_by_node(videos: list[dict]) -> dict[str, list[dict]]:
    """按 duration 交替分配，使负载均衡"""
    # 按 duration 降序排列，然后贪心分配到总时长最小的节点
    sorted_vids = sorted(videos, key=lambda x: x["duration_sec"], reverse=True)
    loads = {"a1502": 0.0, "windows": 0.0}
    assignments: dict[str, list[dict]] = {"a1502": [], "windows": []}

    for v in sorted_vids:
        target = min(loads, key=loads.get)
        assignments[target].append(v)
        loads[target] += v["duration_sec"]

    for node, vids in assignments.items():
        total = sum(v["duration_sec"] for v in vids)
        print(f"[split] {node}: {len(vids)} videos, total {total:.0f}s ({total/3600:.1f}h)")
    return assignments


def main():
    ap = argparse.ArgumentParser(description="分布式坏代理恢复")
    ap.add_argument("--db", default="data/livecuts.db")
    ap.add_argument("--bad-ids", required=True, help="逗号分隔的 video_id 列表")
    ap.add_argument("--artifacts-dir", required=True, help="证据输出目录")
    ap.add_argument("--dry-run", action="store_true", help="只展示分片，不执行")
    args = ap.parse_args()

    bad_ids = [int(x.strip()) for x in args.bad_ids.split(",") if x.strip()]
    videos = load_bad_videos(args.db, bad_ids)
    if not videos:
        print("[error] no videos found")
        sys.exit(1)

    assignments = split_by_node(videos)

    if args.dry_run:
        for node, vids in assignments.items():
            print(f"\n--- {node} ---")
            for v in vids:
                print(f"  vid={v['video_id']} dur={v['duration_sec']:.0f}s segs={len(v['segments'])} name={v['proxy_name']}")
        sys.exit(0)

    artifacts = Path(args.artifacts_dir)
    artifacts.mkdir(parents=True, exist_ok=True)

    # 推送脚本到远端
    for node_key in assignments:
        if assignments[node_key]:
            if not scp_script(node_key):
                print(f"[error] failed to push script to {node_key}")
                sys.exit(1)

    # 两节点并行、每节点内部串行（每次只跑 1 个视频）
    import threading
    node_results: dict[str, list[dict]] = {}

    def _run_node(node_key: str, vids: list[dict]) -> None:
        results = []
        print(f"\n{'='*60}", flush=True)
        print(f"[node] {node_key}: {len(vids)} videos to process", flush=True)
        print(f"{'='*60}", flush=True)
        for v in vids:
            out_path = str(artifacts / f"remote_recover_vid{v['video_id']}_{node_key}.json")
            result = run_remote(node_key, v, out_path)
            results.append(result)
            status = "PASS" if result.get("ok") else "FAIL"
            print(f"[result] vid={v['video_id']} → {node_key} {status} elapsed={result.get('elapsed_sec', '?')}s", flush=True)
        node_results[node_key] = results

    threads = []
    for node_key, vids in assignments.items():
        if vids:
            t = threading.Thread(target=_run_node, args=(node_key, vids), name=node_key)
            t.start()
            threads.append(t)

    for t in threads:
        t.join()

    all_results: list[dict] = []
    for vlist in node_results.values():
        all_results.extend(vlist)

    # 汇总
    summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "total": len(all_results),
        "pass": sum(1 for r in all_results if r.get("ok")),
        "fail": sum(1 for r in all_results if not r.get("ok")),
        "results": all_results,
    }
    summary_path = artifacts / "remote_recover_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False))
    print(f"\n[summary] {summary['pass']}/{summary['total']} passed → {summary_path}")

    if summary["fail"] > 0:
        print(f"[warn] {summary['fail']} videos failed!")
        for r in all_results:
            if not r.get("ok"):
                print(f"  vid={r['video_id']} node={r.get('node')} error={r.get('error', '?')[:100]}")


if __name__ == "__main__":
    main()
