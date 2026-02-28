#!/usr/bin/env python3
"""单视频代理重转 + ffprobe 自检。

用法:
    python3 tools/proxy_recover_one.py --video-id 123 --db data/livecuts.db

远端用法（A1502/Windows, NAS 已挂载）:
    python3 proxy_recover_one.py --video-id 123 \
        --db /dev/null --nas-prefix /Volumes/切片 \
        --proxy-dir /Volumes/切片/proxy \
        --ffmpeg /usr/local/bin/ffmpeg \
        --segments '/Volumes/切片/衣甜/2025/小号/2025/三月/3.9/2025-03-09 .ts' \
        --expected-duration 3761.19 \
        --proxy-name '2025-03-09_小号.mp4'

产出: JSON 文件 (stdout 或 --output 指定路径)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ─── 自检阈值（与现网一致）────────────────────────────
MIN_DURATION_RATIO = 0.95
MAX_AV_GAP_SEC = 2.0


def _ffprobe_available(ffprobe_bin: str) -> bool:
    """检查 ffprobe 是否可用"""
    try:
        r = subprocess.run([ffprobe_bin, "-version"], capture_output=True, timeout=5, errors="replace")
        return r.returncode == 0
    except Exception:
        return False


def _ffmpeg_fallback_durations(path: str, ffmpeg_bin: str = "ffmpeg") -> dict:
    """当 ffprobe 不可用时，用 ffmpeg -i 解析 duration（fallback）"""
    import re
    try:
        r = subprocess.run(
            [ffmpeg_bin, "-i", path, "-f", "null", "-"],
            capture_output=True, text=True, timeout=120, errors="replace",
        )
        stderr = r.stderr
        # 解析总 Duration: HH:MM:SS.ss
        dur_match = re.search(r"Duration:\s+(\d+):(\d+):(\d+)\.(\d+)", stderr)
        total_dur = 0.0
        if dur_match:
            h, m, s, cs = dur_match.groups()
            total_dur = int(h) * 3600 + int(m) * 60 + int(s) + int(cs) / 100.0

        has_video = bool(re.search(r"Stream #\d+:\d+.*Video:", stderr))
        has_audio = bool(re.search(r"Stream #\d+:\d+.*Audio:", stderr))

        # ffmpeg -i 只给总 duration，无法分别获取 video/audio duration
        # 用总 duration 作为两者的近似值
        return {
            "video_duration": total_dur if has_video else 0.0,
            "audio_duration": total_dur if has_audio else 0.0,
            "has_audio": has_audio,
        }
    except Exception:
        return {"video_duration": 0.0, "audio_duration": 0.0, "has_audio": False}


def ffprobe_durations(path: str, ffprobe_bin: str = "ffprobe", ffmpeg_bin: str = "ffmpeg") -> dict:
    """返回 {video_duration, audio_duration, has_audio}
    优先用 ffprobe，不可用时 fallback 到 ffmpeg -i 解析。
    """
    if not _ffprobe_available(ffprobe_bin):
        print(f"[warn] ffprobe not available at '{ffprobe_bin}', falling back to ffmpeg", flush=True)
        return _ffmpeg_fallback_durations(path, ffmpeg_bin)

    def _get_dur(stream_type: str) -> float:
        try:
            r = subprocess.run(
                [ffprobe_bin, "-v", "error",
                 "-select_streams", f"{stream_type}:0",
                 "-show_entries", "stream=duration",
                 "-of", "csv=p=0", path],
                capture_output=True, text=True, timeout=60, errors="replace",
            )
            return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0.0
        except Exception:
            return 0.0

    v = _get_dur("v")
    a = _get_dur("a")
    # has_audio: 检查是否有音频流
    try:
        r = subprocess.run(
            [ffprobe_bin, "-v", "error",
             "-select_streams", "a",
             "-show_entries", "stream=index",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30, errors="replace",
        )
        has_audio = bool(r.stdout.strip())
    except Exception:
        has_audio = False

    return {"video_duration": v, "audio_duration": a, "has_audio": has_audio}


def self_check(proxy_path: str, expected_dur: float, ffprobe_bin: str = "ffprobe",
               ffmpeg_bin: str = "ffmpeg") -> dict:
    """自检：与现网 _probe_proxy_health 逻辑一致"""
    stats = ffprobe_durations(proxy_path, ffprobe_bin, ffmpeg_bin)
    v = stats["video_duration"]
    a = stats["audio_duration"]
    has_audio = stats["has_audio"]

    reasons: list[str] = []
    if v <= 0:
        reasons.append("video_missing")
    if expected_dur > 0 and v > 0 and v < expected_dur * MIN_DURATION_RATIO:
        reasons.append("video_too_short")
    if not has_audio:
        reasons.append("audio_missing")
    elif a <= 0:
        reasons.append("audio_duration_invalid")
    elif expected_dur > 0 and a < expected_dur * MIN_DURATION_RATIO:
        reasons.append("audio_too_short")
    elif v > 0 and (v - a) > MAX_AV_GAP_SEC:
        reasons.append("audio_truncated")

    return {
        "ok": len(reasons) == 0,
        "reasons": reasons,
        "video_duration": v,
        "audio_duration": a,
        "expected_duration": expected_dur,
        "av_gap": round(max(0.0, v - a), 3),
    }


def write_concat_list(paths: list[str]) -> str:
    """创建 ffmpeg concat list 临时文件"""
    fd, fpath = tempfile.mkstemp(suffix=".txt", prefix="concat_")
    with os.fdopen(fd, "w") as f:
        for p in paths:
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
    return fpath


def transcode_single(raw_path: str, out_path: str, ffmpeg_bin: str = "ffmpeg",
                      expected_dur: float = 0.0) -> None:
    """单文件转码"""
    cmd = [
        ffmpeg_bin, "-y",
        "-i", raw_path,
        "-vf", "scale=360:-2",
        "-c:v", "libx264", "-crf", "28", "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        out_path,
    ]
    print(f"[transcode] single: {Path(raw_path).name} → {Path(out_path).name}", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200, errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {proc.stderr[-500:]}")


def transcode_concat_safe(seg_paths: list[str], out_path: str, ffmpeg_bin: str = "ffmpeg",
                           expected_dur: float = 0.0) -> None:
    """多段安全转码：逐段转码 → concat demuxer 拼合"""
    tmpdir = tempfile.mkdtemp(prefix="proxy_safe_")
    seg_outputs: list[str] = []

    for i, sp in enumerate(seg_paths):
        seg_out = os.path.join(tmpdir, f"seg_{i:03d}.mp4")
        cmd = [
            ffmpeg_bin, "-y",
            "-fflags", "+genpts",
            "-i", sp,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=360:-2,format=yuv420p",
            "-c:v", "libx264", "-crf", "28", "-preset", "fast",
            "-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2",
            "-af", "aresample=async=1:first_pts=0",
            "-max_muxing_queue_size", "2048",
            "-movflags", "+faststart",
            seg_out,
        ]
        print(f"[transcode] seg {i+1}/{len(seg_paths)}: {Path(sp).name}", flush=True)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200, errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(f"seg {i} failed: {proc.stderr[-500:]}")
        seg_outputs.append(seg_out)

    # concat
    concat_list = os.path.join(tmpdir, "concat.txt")
    with open(concat_list, "w") as f:
        for so in seg_outputs:
            f.write(f"file '{so}'\n")

    cmd = [
        ffmpeg_bin, "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list,
        "-c", "copy",
        "-movflags", "+faststart",
        out_path,
    ]
    print(f"[transcode] concat {len(seg_outputs)} segs → {Path(out_path).name}", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600, errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"concat failed: {proc.stderr[-500:]}")

    # 清理临时段
    for so in seg_outputs:
        Path(so).unlink(missing_ok=True)
    Path(concat_list).unlink(missing_ok=True)
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass


def transcode_concat_fast(seg_paths: list[str], out_path: str, ffmpeg_bin: str = "ffmpeg") -> None:
    """多段快速转码：concat demuxer 直接读取原始 → 转码输出"""
    concat_list = write_concat_list(seg_paths)
    cmd = [
        ffmpeg_bin, "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list,
        "-vf", "scale=360:-2",
        "-c:v", "libx264", "-crf", "28", "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        out_path,
    ]
    print(f"[transcode] concat-fast {len(seg_paths)} segs → {Path(out_path).name}", flush=True)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=14400, errors="replace")
        if proc.returncode != 0:
            raise RuntimeError(f"concat-fast failed: {proc.stderr[-500:]}")
    finally:
        Path(concat_list).unlink(missing_ok=True)


def has_mixed_formats(seg_paths: list[str]) -> bool:
    """检测分段是否混合了不同格式（.ts + .mp4 等）"""
    exts = set(Path(p).suffix.lower() for p in seg_paths)
    return len(exts) > 1


def main():
    ap = argparse.ArgumentParser(description="单视频代理重转 + 自检")
    ap.add_argument("--video-id", type=int, required=True)
    ap.add_argument("--db", default="data/livecuts.db", help="数据库路径（远端可传 /dev/null）")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--nas-prefix", default="/Volumes/切片")
    ap.add_argument("--proxy-dir", default="/Volumes/切片/proxy")
    ap.add_argument("--output", default="", help="JSON 输出路径（默认 stdout）")
    # 远端模式：直接传参，不读 DB
    ap.add_argument("--segments", nargs="*", default=[], help="原始分段路径列表")
    ap.add_argument("--expected-duration", type=float, default=0.0)
    ap.add_argument("--proxy-name", default="", help="输出文件名（如 2025-03-09_小号.mp4）")
    args = ap.parse_args()

    vid = args.video_id
    seg_paths: list[str] = args.segments
    expected_dur: float = args.expected_duration
    proxy_name: str = args.proxy_name

    # 如果没传 segments，从 DB 读取
    if not seg_paths and args.db != "/dev/null":
        import sqlite3
        conn = sqlite3.connect(args.db)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT session_date, session_label, duration_sec FROM video_registry WHERE id = ?",
            (vid,),
        ).fetchone()
        if not row:
            print(json.dumps({"video_id": vid, "ok": False, "error": "not found in DB"}))
            sys.exit(1)
        expected_dur = float(row["duration_sec"] or 0)
        label = (row["session_label"] or "main").replace("/", "-").replace("\\", "-")
        proxy_name = f"{row['session_date']}_{label}.mp4"
        segs = conn.execute(
            "SELECT raw_path FROM video_segments WHERE video_id = ? ORDER BY segment_index",
            (vid,),
        ).fetchall()
        seg_paths = [s["raw_path"] for s in segs]
        conn.close()

    if not seg_paths:
        print(json.dumps({"video_id": vid, "ok": False, "error": "no segments"}))
        sys.exit(1)

    proxy_dir = Path(args.proxy_dir)
    proxy_dir.mkdir(parents=True, exist_ok=True)
    proxy_path = proxy_dir / proxy_name
    tmp_path = proxy_dir / f".tmp_{proxy_name}.{int(time.time()*1000)}.mp4"

    # 检查原始文件是否存在
    missing = [p for p in seg_paths if not Path(p).exists()]
    if missing:
        result = {
            "video_id": vid,
            "ok": False,
            "error": f"missing raw files: {missing[:3]}",
            "proxy_name": proxy_name,
        }
        _output(result, args.output)
        sys.exit(1)

    t0 = time.time()
    try:
        if len(seg_paths) == 1:
            transcode_single(seg_paths[0], str(tmp_path), args.ffmpeg, expected_dur)
        elif has_mixed_formats(seg_paths):
            # 混合格式 → 安全路径（逐段转码再拼合）
            print(f"[info] mixed formats detected, using safe path", flush=True)
            transcode_concat_safe(seg_paths, str(tmp_path), args.ffmpeg, expected_dur)
        else:
            # 尝试快速路径，失败降级安全路径
            try:
                transcode_concat_fast(seg_paths, str(tmp_path), args.ffmpeg)
            except RuntimeError as e:
                print(f"[warn] fast path failed, falling back to safe: {e}", flush=True)
                tmp_path.unlink(missing_ok=True)
                transcode_concat_safe(seg_paths, str(tmp_path), args.ffmpeg, expected_dur)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        result = {
            "video_id": vid,
            "ok": False,
            "error": str(exc)[:500],
            "proxy_name": proxy_name,
            "elapsed_sec": round(time.time() - t0, 1),
        }
        _output(result, args.output)
        sys.exit(1)

    elapsed = round(time.time() - t0, 1)

    # 自检
    check = self_check(str(tmp_path), expected_dur, args.ffprobe, args.ffmpeg)
    if not check["ok"]:
        tmp_path.unlink(missing_ok=True)
        result = {
            "video_id": vid,
            "ok": False,
            "error": f"self_check failed: {check['reasons']}",
            "check": check,
            "proxy_name": proxy_name,
            "elapsed_sec": elapsed,
        }
        _output(result, args.output)
        sys.exit(1)

    # 原子替换
    if proxy_path.exists():
        bak = proxy_dir / f".bak_{proxy_name}"
        proxy_path.replace(bak)
        tmp_path.replace(proxy_path)
        bak.unlink(missing_ok=True)
    else:
        tmp_path.replace(proxy_path)

    result = {
        "video_id": vid,
        "ok": True,
        "proxy_path": str(proxy_path),
        "proxy_name": proxy_name,
        "check": check,
        "elapsed_sec": elapsed,
        "seg_count": len(seg_paths),
        "mixed_formats": has_mixed_formats(seg_paths),
        "host": os.uname().nodename if hasattr(os, "uname") else os.environ.get("COMPUTERNAME", "unknown"),
    }
    _output(result, args.output)
    print(f"[done] vid={vid} ok=True elapsed={elapsed}s", flush=True)


def _output(data: dict, path: str):
    s = json.dumps(data, indent=2, ensure_ascii=False)
    if path:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(s, encoding="utf-8")
        print(f"[output] {path}", flush=True)
    else:
        print(s)


if __name__ == "__main__":
    main()
