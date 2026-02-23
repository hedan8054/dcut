"""NAS 视频目录自动扫描 — 从目录结构解析日期和场次标签，自动检测分段"""
import logging
import re
from collections import defaultdict
from pathlib import Path

from backend.config import RAW_VIDEO_ROOT

logger = logging.getLogger(__name__)

# 中文月份映射
MONTH_MAP = {
    "一月": 1, "二月": 2, "三月": 3, "四月": 4, "五月": 5, "六月": 6,
    "七月": 7, "八月": 8, "九月": 9, "十月": 10, "十一月": 11, "十二月": 12,
    "1月": 1, "2月": 2, "3月": 3, "4月": 4, "5月": 5, "6月": 6,
    "7月": 7, "8月": 8, "9月": 9, "10月": 10, "11月": 11, "12月": 12,
}

# 中文数字映射
CN_NUM = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
}

# 视频文件扩展名
VIDEO_EXTS = {".ts", ".mp4", ".mkv", ".flv"}


def _parse_day_dir(name: str, year: int) -> str | None:
    """从日期目录名解析出 YYYY-MM-DD 格式

    支持的格式:
      - "1.01"        → 2025-01-01
      - "10.21"       → 2025-10-21
      - "2025年11月11日" → 2025-11-11
      - "12.01"       → 2025-12-01
      - "11,8新"      → 2025-11-08
      - "11.11新"     → 2025-11-11
    """
    # 格式: YYYY年MM月DD日
    m = re.match(r"(\d{4})年(\d{1,2})月(\d{1,2})日", name)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"

    # 去掉尾部的"新"等杂字
    clean = re.sub(r"[^\d.,]", "", name)

    # 格式: M.DD 或 M,DD
    m = re.match(r"(\d{1,2})[.,](\d{1,2})", clean)
    if m:
        month = int(m.group(1))
        day = int(m.group(2))
        if 1 <= month <= 12 and 1 <= day <= 31:
            return f"{year}-{month:02d}-{day:02d}"

    return None


def _resolve_month_dir(name: str) -> int | None:
    """从月份目录名解析出月份数字"""
    if name in MONTH_MAP:
        return MONTH_MAP[name]
    # 纯数字月份也匹配（如果上面没匹配到）
    m = re.match(r"^(\d{1,2})月?$", name)
    if m:
        v = int(m.group(1))
        if 1 <= v <= 12:
            return v
    return None


def _parse_file_order(filename: str) -> tuple[int, int, str]:
    """从文件名提取排序 key，用于确定分段播放顺序

    返回 (session_num, part_num, timestamp_or_name) 用于排序。
    同一日期目录下的文件按此 key 排序后，依次编号为 segment 0, 1, 2...

    命名模式:
      - (X-Y) 或 （X-Y）: 场次X 分段Y → session=X, part=Y
      - (N) 或 （N）: 分段N → session=0, part=N
      - （一/二/三）: 中文序号 → session=0, part=对应数字
      - 第X场: 独立场次标记 → session=X, part=0
      - YYYYMMDDHHmmss: 时间戳 → 按时间排序
      - 其他: 按文件名排序
    """
    name = Path(filename).stem

    # 模式: (X-Y) 或 （X-Y） — 场次X, 分段Y
    m = re.search(r'[（(](\d+)[—\-](\d+)[）)]', name)
    if m:
        return (int(m.group(1)), int(m.group(2)), '')

    # 模式: (N) 或 （N） — 分段N
    m = re.search(r'[（(](\d+)[）)]', name)
    if m:
        return (0, int(m.group(1)), '')

    # 模式: （一/二/三） — 中文序号
    m = re.search(r'[（(]([一二三四五六七八九十])[）)]', name)
    if m:
        cn = m.group(1)
        if cn in CN_NUM:
            return (0, CN_NUM[cn], '')

    # 模式: 第X场 — 独立场次
    m = re.search(r'第([一二三四五六七八九十])场', name)
    if m:
        cn = m.group(1)
        if cn in CN_NUM:
            return (CN_NUM[cn], 0, '')

    # 模式: 时间戳 YYYYMMDDHHmmss (10-14位数字)
    m = re.search(r'(\d{10,14})', name)
    if m:
        return (0, 0, m.group(1))

    # 兜底: 按文件名排序
    return (0, 0, name)


def scan_video_directory() -> list[dict]:
    """扫描 NAS 视频目录，返回所有可登记的视频

    Returns:
        [{ session_date, session_label, segments: [{ path, size, segment_index }] }]
        segments 按播放顺序排列，按 session_date DESC 排序
    """
    root = RAW_VIDEO_ROOT
    if not root.exists():
        logger.warning(f"视频根目录不存在: {root}")
        return []

    # 收集: (date_str, label) → [{ path, size, order_key }]
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)

    for year_dir in sorted(root.iterdir()):
        if not year_dir.is_dir():
            continue
        try:
            year = int(year_dir.name)
        except ValueError:
            continue

        # 判断下一级是场次标签还是直接月份
        for sub in sorted(year_dir.iterdir()):
            if not sub.is_dir():
                continue

            # 尝试解析为月份 → 2024 没有 label 层
            if _resolve_month_dir(sub.name) is not None:
                _scan_month_dir(sub, year, "", groups)
                continue

            # 场次标签（大号/小号/施老板）
            label = sub.name
            # 有的场次标签下还有一个年份子目录（小号/2025/...）
            for month_or_year in sorted(sub.iterdir()):
                if not month_or_year.is_dir():
                    continue

                # 如果是年份目录（如 "2025"），再往下找月份
                try:
                    sub_year = int(month_or_year.name)
                    for month_dir in sorted(month_or_year.iterdir()):
                        if month_dir.is_dir():
                            _scan_month_dir(month_dir, sub_year, label, groups)
                    continue
                except ValueError:
                    pass

                # 直接是月份目录
                _scan_month_dir(month_or_year, year, label, groups)

    # 转为列表，排序分段并分配 segment_index
    results = []
    for (date_str, label), files in groups.items():
        # 按 order_key 排序，确定播放顺序
        files.sort(key=lambda f: f["order_key"])

        segments = []
        for idx, f in enumerate(files):
            segments.append({
                "path": f["path"],
                "size": f["size"],
                "segment_index": idx,
            })

        results.append({
            "session_date": date_str,
            "session_label": label,
            "segments": segments,
        })

    # 按日期倒序
    results.sort(key=lambda r: r["session_date"], reverse=True)
    total_files = sum(len(r["segments"]) for r in results)
    multi = sum(1 for r in results if len(r["segments"]) > 1)
    logger.info(f"NAS 扫描完成: {len(results)} 个场次, {total_files} 个文件, {multi} 个多段场次")
    return results


def _scan_month_dir(
    month_dir: Path, year: int, label: str,
    groups: dict[tuple[str, str], list[dict]],
) -> None:
    """扫描月份目录下的日期子目录"""
    for day_dir in month_dir.iterdir():
        if not day_dir.is_dir():
            continue

        date_str = _parse_day_dir(day_dir.name, year)
        if not date_str:
            continue

        # 扫描视频文件
        for f in day_dir.iterdir():
            if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
                groups[(date_str, label)].append({
                    "path": str(f),
                    "size": f.stat().st_size,
                    "order_key": _parse_file_order(f.name),
                })
