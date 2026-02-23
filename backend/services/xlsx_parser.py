"""XLSX 解析器 - 从 v1.1 material-parser.ts 移植

实际 xlsx 列头:
  商品id | 商品名称 | 商品售价 | 合作者名称 | 佣金率 | 推广链接 |
  上新时间 | 商品状态 | 异常情况 | 款号 |
  2026素材时间 | 2025素材时间 | 2024素材时间

核心改动:
- 列头映射: 实际列头 → 内部字段名
- 素材按年份分列: 2026/2025/2024 各自独立解析
"""
import hashlib
import re
from dataclasses import dataclass, field

SESSION_LABELS = ['第二场', '大号', '小号']
HOST_LABELS = ['施老板']

# 实际 xlsx 列头 → 内部字段名映射
COLUMN_MAP: dict[str, str] = {
    '款号': 'sku_code',
    '商品名称': 'product_name',
    '商品售价': 'price',
    '合作者名称': 'shop_name',
    '佣金率': 'commission_rate',
    '推广链接': 'promo_link',
    '上新时间': 'launch_date',
    '商品状态': 'product_status',
    '异常情况': 'abnormal_note',
    '商品id': 'product_id',
    # 素材列按年份处理
    '2026素材时间': 'material_2026',
    '2025素材时间': 'material_2025',
    '2024素材时间': 'material_2024',
    # 兼容旧格式
    '品名': 'product_name',
    '单价': 'price',
    '合作商家': 'shop_name',
    '佣金比例': 'commission_rate',
    '上架日期': 'launch_date',
    '状态': 'product_status',
    '异常信息': 'abnormal_note',
    '素材': 'material_single',
}

# 素材年份列 pattern: "XXXX素材时间"
MATERIAL_YEAR_PATTERN = re.compile(r'^(\d{4})素材时间$')


@dataclass
class ParsedFragment:
    material_year: int
    raw_fragment: str
    normalized_fragment: str
    normalized_fragment_hash: str
    material_month: int | None = None
    material_day: int | None = None
    session_label: str | None = None
    host_label: str | None = None
    time_points: list[str] = field(default_factory=list)
    parse_confidence: str = "LOW"


@dataclass
class ParsedProduct:
    """从 xlsx 行解析出的商品信息"""
    sku_code: str
    product_id: str = ""
    product_name: str = ""
    price: float | None = None
    shop_name: str = ""
    commission_rate: float | None = None
    promo_link: str = ""
    launch_date: str | None = None
    product_status: str = ""
    abnormal_note: str = ""


@dataclass
class ParsedRow:
    """一行 xlsx 数据：商品 + 多个 fragment"""
    product: ParsedProduct
    fragments: list[ParsedFragment] = field(default_factory=list)


def to_half_width(text: str) -> str:
    """全角字符转半角"""
    out = []
    for ch in text:
        code = ord(ch)
        if code == 0x3000:
            out.append(' ')
        elif 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    return ''.join(out)


def normalize_material_cell(raw: str) -> str:
    """标准化素材 cell 文本"""
    half = to_half_width(str(raw or ''))
    result = re.sub(r'\r\n|\n|\r', '/', half)
    result = re.sub(r'[；;|｜]+', '/', result)
    result = re.sub(r'[，、]+', ' ', result)
    result = re.sub(r'/{2,}', '/', result)
    result = re.sub(r'\s+', ' ', result)
    return result.strip().strip('/')


def normalize_fragment_for_hash(text: str) -> str:
    """标准化 fragment 用于去重 hash"""
    result = to_half_width(text).lower()
    result = re.sub(r'[\s\t]+', ' ', result)
    result = re.sub(r'["""\'\`]+', '', result)
    result = re.sub(r'[，,。\.]+', '', result)
    return result.strip()


def normalize_time_point(t: str) -> str:
    """'3:01' → '03:01'"""
    h, m = t.split(':')
    return f"{int(h):02d}:{m}"


def find_first_match(text: str, labels: list[str]) -> str | None:
    for label in labels:
        if label in text:
            return label
    return None


def find_host_label(text: str) -> str | None:
    fixed = find_first_match(text, HOST_LABELS)
    if fixed:
        return fixed
    m = re.search(r'([\u4e00-\u9fa5A-Za-z]{1,8}老板)', text)
    return m.group(1) if m else None


def clamp_date_number(val: int, lo: int, hi: int) -> int | None:
    if val < lo or val > hi:
        return None
    return val


def infer_confidence(has_date: bool, has_time: bool) -> str:
    if has_date and has_time:
        return "HIGH"
    if has_date or has_time:
        return "MEDIUM"
    return "LOW"


def parse_material_cell(raw_cell: str, material_year: int) -> list[ParsedFragment]:
    """解析一个素材 cell，返回 ParsedFragment 列表"""
    cleaned = normalize_material_cell(raw_cell)
    if not cleaned or cleaned in ('0', '0.0'):
        return []

    # 按 '/' 拆分
    if '/' in cleaned:
        parts = [p.strip() for p in cleaned.split('/') if p.strip()]
    else:
        parts = [cleaned]

    results = []
    for part in parts:
        frag = _parse_one_fragment(part, material_year)
        if frag:
            results.append(frag)
    return results


def _parse_one_fragment(raw_fragment: str, material_year: int) -> ParsedFragment | None:
    """解析单个 fragment"""
    fragment = raw_fragment.strip()
    if not fragment:
        return None

    # 提取日期: "X月X日" 或 "X月X号"
    date_match = re.search(r'(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?', fragment)
    material_month = clamp_date_number(int(date_match.group(1)), 1, 12) if date_match else None
    material_day = clamp_date_number(int(date_match.group(2)), 1, 31) if date_match else None

    # 提取时间点: HH:MM 格式（支持 0:17 到 23:59）
    # 用 lookaround 替代 \b，因为 CJK 字符在 Python re 中是 \w，导致 \b 不生效
    time_matches = re.findall(r'(?<!\d)(\d{1,2}:\d{2})(?!\d)', fragment)
    seen: set[str] = set()
    time_points: list[str] = []
    for t in time_matches:
        nt = normalize_time_point(t)
        if nt not in seen:
            seen.add(nt)
            time_points.append(nt)

    session_label = find_first_match(fragment, SESSION_LABELS)
    host_label = find_host_label(fragment)

    has_date = material_month is not None and material_day is not None
    confidence = infer_confidence(has_date, len(time_points) > 0)

    normalized = normalize_fragment_for_hash(fragment)
    frag_hash = hashlib.sha1(normalized.encode()).hexdigest()

    return ParsedFragment(
        material_year=material_year,
        raw_fragment=fragment,
        normalized_fragment=normalized,
        normalized_fragment_hash=frag_hash,
        material_month=material_month,
        material_day=material_day,
        session_label=session_label,
        host_label=host_label,
        time_points=time_points,
        parse_confidence=confidence,
    )


def normalize_sku_code(raw: str) -> str:
    """标准化 SKU 码"""
    return str(raw or '').strip().upper()


def extract_product_id(promo_link: str, fallback: str) -> str:
    """从推广链接提取商品 ID"""
    link = str(promo_link or '').strip()
    if link:
        m = re.search(r'[?&]id=(\d{8,})\b', link)
        if m:
            return m.group(1)
        try:
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(link)
            pid = parse_qs(parsed.query).get('id', [''])[0].strip()
            if re.match(r'^\d{8,}$', pid):
                return pid
        except Exception:
            pass

    # fallback: 处理科学计数法
    raw = str(fallback or '').strip()
    if not raw:
        return ""
    if re.match(r'^\d+$', raw):
        return raw
    sci = re.match(r'^(\d+(?:\.\d+)?)e\+?(\d+)$', raw, re.IGNORECASE)
    if sci:
        mantissa = sci.group(1)
        exponent = int(sci.group(2))
        digits = mantissa.replace('.', '')
        decimal_digits = len(mantissa) - mantissa.index('.') - 1 if '.' in mantissa else 0
        zeros_needed = exponent - decimal_digits
        if zeros_needed >= 0:
            return digits + '0' * zeros_needed
    try:
        val = float(raw)
        if val > 0:
            return str(int(val))
    except (ValueError, OverflowError):
        pass
    return raw


def safe_float(val) -> float | None:
    if val is None:
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def safe_str(val) -> str:
    if val is None:
        return ""
    return str(val).strip()


def _map_row(row: dict[str, object]) -> dict[str, object]:
    """将原始列头映射为内部字段名"""
    mapped: dict[str, object] = {}
    material_years: dict[int, str] = {}  # year -> cell value

    for col_name, value in row.items():
        if not col_name:
            continue
        col_name_str = str(col_name).strip()

        # 检查是否是素材年份列
        year_match = MATERIAL_YEAR_PATTERN.match(col_name_str)
        if year_match:
            year = int(year_match.group(1))
            material_years[year] = safe_str(value)
            continue

        # 常规列映射
        internal = COLUMN_MAP.get(col_name_str)
        if internal:
            mapped[internal] = value

    mapped['_material_years'] = material_years
    return mapped


def parse_xlsx_rows(rows: list[dict], default_year: int) -> list[ParsedRow]:
    """解析 xlsx 行列表，返回 ParsedRow 列表

    支持两种格式:
    1. 多年份列: "2026素材时间" "2025素材时间" "2024素材时间"
    2. 单素材列: "素材"（使用 default_year）
    """
    results = []
    for row in rows:
        mapped = _map_row(row)

        sku_raw = safe_str(mapped.get('sku_code', ''))
        if not sku_raw:
            continue

        sku_code = normalize_sku_code(sku_raw)

        product = ParsedProduct(
            sku_code=sku_code,
            product_id=extract_product_id(
                safe_str(mapped.get('promo_link', '')),
                safe_str(mapped.get('product_id', '')),
            ),
            product_name=safe_str(mapped.get('product_name', '')),
            price=safe_float(mapped.get('price')),
            shop_name=safe_str(mapped.get('shop_name', '')),
            commission_rate=safe_float(mapped.get('commission_rate')),
            promo_link=safe_str(mapped.get('promo_link', '')),
            launch_date=safe_str(mapped.get('launch_date', '')) or None,
            product_status=safe_str(mapped.get('product_status', '')),
            abnormal_note=safe_str(mapped.get('abnormal_note', '')),
        )

        # 解析素材 — 支持多年份列
        fragments: list[ParsedFragment] = []
        material_years: dict[int, str] = mapped.get('_material_years', {})

        if material_years:
            # 多年份列模式
            for year, cell_value in sorted(material_years.items(), reverse=True):
                if cell_value:
                    fragments.extend(parse_material_cell(cell_value, year))
        else:
            # 单列模式 (兼容)
            material_raw = safe_str(mapped.get('material_single', ''))
            if material_raw:
                fragments.extend(parse_material_cell(material_raw, default_year))

        results.append(ParsedRow(product=product, fragments=fragments))

    return results
