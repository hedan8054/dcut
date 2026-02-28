#!/usr/bin/env python3
"""vid=68 转码策略 A/B 对比诊断。

不写 DB、不覆盖 proxy，仅输出 candidate 到临时目录做 ffprobe 对比。

策略:
  A (主线 safe): 逐段转码 → concat copy（transcode_concat_safe）
  B (fast):      concat demuxer → 单次转码（transcode_concat_fast）

产出: proxy68_strategy_compare_<timestamp>.json
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def ffprobe_durations(path: str) -> dict:
    """返回 {video_duration, audio_duration, has_audio}"""
    def _get_dur(stream_type: str) -> float:
        try:
            r = subprocess.run(
                ["ffprobe", "-v", "error",
                 "-select_streams", f"{stream_type}:0",
                 "-show_entries", "stream=duration",
                 "-of", "csv=p=0", path],
                capture_output=True, text=True, timeout=60,
            )
            return float(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 0.0
        except Exception:
            return 0.0

    v = _get_dur("v")
    a = _get_dur("a")
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error",
             "-select_streams", "a",
             "-show_entries", "stream=index",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
        has_audio = bool(r.stdout.strip())
    except Exception:
        has_audio = False

    return {"video_duration": v, "audio_duration": a, "has_audio": has_audio}


def strategy_safe(seg_paths: list[str], out_path: str, ffmpeg_bin: str = "ffmpeg") -> dict:
    """策略 A: 逐段转码 → concat copy"""
    tmpdir = tempfile.mkdtemp(prefix="diag_safe_")
    seg_outputs = []
    t0 = time.time()

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
        print(f"[safe] seg {i+1}/{len(seg_paths)}: {Path(sp).name}", flush=True)
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if proc.returncode != 0:
            return {"ok": False, "error": f"seg {i} failed: {proc.stderr[-300:]}", "elapsed_sec": round(time.time() - t0, 1)}
        seg_outputs.append(seg_out)

    # concat copy
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
    print(f"[safe] concat {len(seg_outputs)} segs → {Path(out_path).name}", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    elapsed = round(time.time() - t0, 1)

    if proc.returncode != 0:
        return {"ok": False, "error": f"concat failed: {proc.stderr[-300:]}", "elapsed_sec": elapsed}

    # 清理
    for so in seg_outputs:
        Path(so).unlink(missing_ok=True)
    Path(concat_list).unlink(missing_ok=True)
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass

    return {"ok": True, "elapsed_sec": elapsed}


def strategy_fast(seg_paths: list[str], out_path: str, ffmpeg_bin: str = "ffmpeg") -> dict:
    """策略 B: concat demuxer → 单次转码"""
    t0 = time.time()
    fd, concat_file = tempfile.mkstemp(suffix=".txt", prefix="diag_fast_")
    with os.fdopen(fd, "w") as f:
        for p in seg_paths:
            escaped = p.replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    cmd = [
        ffmpeg_bin, "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_file,
        "-vf", "scale=360:-2",
        "-c:v", "libx264", "-crf", "28", "-preset", "fast",
        "-c:a", "aac", "-b:a", "64k",
        out_path,
    ]
    print(f"[fast] concat-fast {len(seg_paths)} segs → {Path(out_path).name}", flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=14400)
    elapsed = round(time.time() - t0, 1)
    Path(concat_file).unlink(missing_ok=True)

    if proc.returncode != 0:
        return {"ok": False, "error": f"fast failed: {proc.stderr[-300:]}", "elapsed_sec": elapsed}

    return {"ok": True, "elapsed_sec": elapsed}


def main():
    import sqlite3

    db_path = "data/livecuts.db"
    vid = 68
    artifacts_dir = "docs/meeting-room/rooms/p0-stability-regression-hardening/execution/reports/artifacts"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT id, session_date, session_label, duration_sec FROM video_registry WHERE id = ?", (vid,)
    ).fetchone()
    segs = conn.execute(
        "SELECT raw_path FROM video_segments WHERE video_id = ? ORDER BY segment_index", (vid,)
    ).fetchall()
    conn.close()

    seg_paths = [s["raw_path"] for s in segs]
    expected_dur = float(row["duration_sec"] or 0)

    print(f"[diag] vid={vid} expected_dur={expected_dur:.1f}s segs={len(seg_paths)}", flush=True)
    for i, p in enumerate(seg_paths):
        print(f"  seg[{i}]: {Path(p).suffix} {Path(p).name}", flush=True)

    # 检查源文件存在
    missing = [p for p in seg_paths if not Path(p).exists()]
    if missing:
        print(f"[error] missing files: {missing}")
        sys.exit(1)

    tmpdir = tempfile.mkdtemp(prefix="proxy68_diag_")
    safe_out = os.path.join(tmpdir, "candidate_safe.mp4")
    fast_out = os.path.join(tmpdir, "candidate_fast.mp4")

    results = {"video_id": vid, "expected_duration": expected_dur, "seg_count": len(seg_paths)}

    # 策略 A: safe
    print("\n=== Strategy A: safe (per-seg transcode → concat copy) ===", flush=True)
    r_safe = strategy_safe(seg_paths, safe_out)
    results["strategy_safe"] = r_safe
    if r_safe["ok"]:
        probe = ffprobe_durations(safe_out)
        results["strategy_safe"]["probe"] = probe
        results["strategy_safe"]["file_size"] = os.path.getsize(safe_out)
        av_gap = round(max(0.0, probe["video_duration"] - probe["audio_duration"]), 3)
        dur_ratio = probe["video_duration"] / expected_dur if expected_dur > 0 else 0
        results["strategy_safe"]["av_gap"] = av_gap
        results["strategy_safe"]["dur_ratio"] = round(dur_ratio, 4)
        print(f"[safe] OK: v={probe['video_duration']:.1f}s a={probe['audio_duration']:.1f}s gap={av_gap}s ratio={dur_ratio:.4f}", flush=True)
    else:
        print(f"[safe] FAIL: {r_safe.get('error', '?')[:200]}", flush=True)

    # 策略 B: fast
    print("\n=== Strategy B: fast (concat demuxer → single transcode) ===", flush=True)
    r_fast = strategy_fast(seg_paths, fast_out)
    results["strategy_fast"] = r_fast
    if r_fast["ok"]:
        probe = ffprobe_durations(fast_out)
        results["strategy_fast"]["probe"] = probe
        results["strategy_fast"]["file_size"] = os.path.getsize(fast_out)
        av_gap = round(max(0.0, probe["video_duration"] - probe["audio_duration"]), 3)
        dur_ratio = probe["video_duration"] / expected_dur if expected_dur > 0 else 0
        results["strategy_fast"]["av_gap"] = av_gap
        results["strategy_fast"]["dur_ratio"] = round(dur_ratio, 4)
        print(f"[fast] OK: v={probe['video_duration']:.1f}s a={probe['audio_duration']:.1f}s gap={av_gap}s ratio={dur_ratio:.4f}", flush=True)
    else:
        print(f"[fast] FAIL: {r_fast.get('error', '?')[:200]}", flush=True)

    # 对比结论
    conclusion = {
        "safe_ok": r_safe["ok"],
        "fast_ok": r_fast["ok"],
    }
    if r_safe["ok"] and r_fast["ok"]:
        conclusion["winner"] = "safe" if results["strategy_safe"]["av_gap"] <= results["strategy_fast"]["av_gap"] else "fast"
        conclusion["safe_speed_sec"] = r_safe["elapsed_sec"]
        conclusion["fast_speed_sec"] = r_fast["elapsed_sec"]
        conclusion["speed_ratio"] = round(r_safe["elapsed_sec"] / r_fast["elapsed_sec"], 2) if r_fast["elapsed_sec"] > 0 else 0
    elif r_safe["ok"]:
        conclusion["winner"] = "safe"
        conclusion["reason"] = "fast strategy failed for mixed ts+mp4 format"
    elif r_fast["ok"]:
        conclusion["winner"] = "fast"
    else:
        conclusion["winner"] = "none"
        conclusion["reason"] = "both strategies failed"
    results["conclusion"] = conclusion

    # 清理临时文件
    for f in [safe_out, fast_out]:
        Path(f).unlink(missing_ok=True)
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass

    # 输出
    ts = time.strftime("%Y%m%dT%H%M%S")
    out_path = os.path.join(artifacts_dir, f"proxy68_strategy_compare_{ts}.json")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\n[output] {out_path}", flush=True)

    # 摘要
    print(f"\n=== CONCLUSION ===")
    print(f"Winner: {conclusion['winner']}")
    if "reason" in conclusion:
        print(f"Reason: {conclusion['reason']}")
    if "speed_ratio" in conclusion:
        print(f"Speed: safe={r_safe['elapsed_sec']}s, fast={r_fast['elapsed_sec']}s, ratio={conclusion['speed_ratio']}x")


if __name__ == "__main__":
    main()
