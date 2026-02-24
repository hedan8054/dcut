"""xlsx_parser 纯函数测试

覆盖: normalize_material_cell, parse_material_cell, to_half_width,
       normalize_sku_code, extract_product_id, infer_confidence
"""
import pytest
from backend.services.xlsx_parser import (
    to_half_width,
    normalize_material_cell,
    normalize_fragment_for_hash,
    normalize_time_point,
    parse_material_cell,
    normalize_sku_code,
    extract_product_id,
    infer_confidence,
    find_host_label,
    clamp_date_number,
    safe_float,
    safe_str,
)


class TestToHalfWidth:
    def test_fullwidth_digits(self):
        assert to_half_width('１２３') == '123'

    def test_fullwidth_latin(self):
        assert to_half_width('Ａ') == 'A'

    def test_fullwidth_space(self):
        assert to_half_width('　') == ' '

    def test_mixed_cjk_and_fullwidth(self):
        assert to_half_width('大号３月') == '大号3月'

    def test_already_halfwidth(self):
        assert to_half_width('hello 123') == 'hello 123'


class TestNormalizeMaterialCell:
    def test_basic_normalization(self):
        assert normalize_material_cell('1月3日 3:01') == '1月3日 3:01'

    def test_newlines_to_slash(self):
        assert normalize_material_cell('1月3日\n3:01') == '1月3日/3:01'

    def test_semicolons_to_slash(self):
        assert normalize_material_cell('A；B;C') == 'A/B/C'

    def test_commas_to_space(self):
        # 全角逗号 '，' 先被 to_half_width 转为半角 ','，regex [，、] 不匹配半角逗号
        # 只有顿号 '、' 被替换为空格
        assert normalize_material_cell('A，B、C') == 'A,B C'
        assert normalize_material_cell('A、B、C') == 'A B C'

    def test_empty_and_zero(self):
        assert normalize_material_cell('') == ''
        # 注意: '0' 和 '0.0' 的过滤在 parse_material_cell 中，不在 normalize 中
        assert normalize_material_cell('0') == '0'
        assert normalize_material_cell('0.0') == '0.0'

    def test_strip_trailing_slash(self):
        assert normalize_material_cell('/hello/') == 'hello'

    def test_fullwidth_conversion(self):
        assert normalize_material_cell('１月３日') == '1月3日'


class TestParseMaterialCell:
    def test_simple_date_time(self):
        frags = parse_material_cell('1月3日 3:01 大号', 2025)
        assert len(frags) == 1
        f = frags[0]
        assert f.material_year == 2025
        assert f.material_month == 1
        assert f.material_day == 3
        assert f.time_points == ['03:01']
        assert f.session_label == '大号'
        assert f.parse_confidence == 'HIGH'

    def test_multiple_fragments(self):
        frags = parse_material_cell('1月3日 3:01/2月5日 小号', 2025)
        assert len(frags) == 2
        assert frags[0].material_month == 1
        assert frags[1].material_month == 2
        assert frags[1].session_label == '小号'

    def test_no_date(self):
        frags = parse_material_cell('3:01', 2025)
        assert len(frags) == 1
        assert frags[0].material_month is None
        assert frags[0].time_points == ['03:01']
        assert frags[0].parse_confidence == 'MEDIUM'

    def test_date_only(self):
        frags = parse_material_cell('3月15日', 2025)
        assert len(frags) == 1
        assert frags[0].material_month == 3
        assert frags[0].material_day == 15
        assert frags[0].time_points == []
        assert frags[0].parse_confidence == 'MEDIUM'

    def test_empty_input(self):
        assert parse_material_cell('', 2025) == []
        assert parse_material_cell('0', 2025) == []

    def test_multiple_time_points(self):
        frags = parse_material_cell('1月3日 3:01 4:15', 2025)
        assert len(frags) == 1
        assert frags[0].time_points == ['03:01', '04:15']

    def test_host_label(self):
        frags = parse_material_cell('1月3日 施老板', 2025)
        assert len(frags) == 1
        assert frags[0].host_label == '施老板'

    def test_dedup_time_points(self):
        """相同时间点不应重复"""
        frags = parse_material_cell('3:01 3:01 大号', 2025)
        assert len(frags) == 1
        assert frags[0].time_points == ['03:01']

    def test_invalid_month_day(self):
        """月份/日期超出范围应返回 None"""
        frags = parse_material_cell('13月32日', 2025)
        assert len(frags) == 1
        assert frags[0].material_month is None
        assert frags[0].material_day is None

    def test_hash_consistency(self):
        """相同内容的 fragment 应该有相同的 hash"""
        frags1 = parse_material_cell('1月3日 3:01', 2025)
        frags2 = parse_material_cell('1月3日 3:01', 2025)
        assert frags1[0].normalized_fragment_hash == frags2[0].normalized_fragment_hash


class TestNormalizeSkuCode:
    def test_basic(self):
        assert normalize_sku_code('abc123') == 'ABC123'

    def test_whitespace(self):
        assert normalize_sku_code('  abc ') == 'ABC'

    def test_empty(self):
        assert normalize_sku_code('') == ''
        assert normalize_sku_code(None) == ''


class TestExtractProductId:
    def test_from_promo_link(self):
        link = 'https://example.com/item?id=12345678&foo=bar'
        assert extract_product_id(link, '') == '12345678'

    def test_from_fallback_plain(self):
        assert extract_product_id('', '12345678') == '12345678'

    def test_from_scientific_notation(self):
        assert extract_product_id('', '3.72e+18') == '3720000000000000000'

    def test_empty(self):
        assert extract_product_id('', '') == ''


class TestInferConfidence:
    def test_high(self):
        assert infer_confidence(True, True) == 'HIGH'

    def test_medium_date_only(self):
        assert infer_confidence(True, False) == 'MEDIUM'

    def test_medium_time_only(self):
        assert infer_confidence(False, True) == 'MEDIUM'

    def test_low(self):
        assert infer_confidence(False, False) == 'LOW'


class TestHelpers:
    def test_normalize_time_point(self):
        assert normalize_time_point('3:01') == '03:01'
        assert normalize_time_point('12:30') == '12:30'

    def test_find_host_label(self):
        assert find_host_label('施老板在播') == '施老板'
        assert find_host_label('无关内容') is None

    def test_clamp_date_number(self):
        assert clamp_date_number(1, 1, 12) == 1
        assert clamp_date_number(13, 1, 12) is None
        assert clamp_date_number(0, 1, 12) is None

    def test_safe_float(self):
        assert safe_float(3.14) == 3.14
        assert safe_float('2.5') == 2.5
        assert safe_float(None) is None
        assert safe_float('abc') is None

    def test_safe_str(self):
        assert safe_str(None) == ''
        assert safe_str(123) == '123'
        assert safe_str(' hello ') == 'hello'
