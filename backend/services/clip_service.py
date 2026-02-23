"""CLIP 图像相似度搜索服务 — FashionCLIP + YOLO人体检测 + HSV色彩匹配

以商品图在视频帧中搜索对应片段：
1. FashionCLIP (patrickjohncyh/fashion-clip) 替换通用 ViT-B-32，服装领域更准
2. YOLO 检测人体 → 裁剪上半身(torso 60%)，聚焦衣服区域
3. HSV 色彩直方图 96 维特征，补充颜色匹配信号
4. 混合评分: 0.7 * clip_similarity + 0.3 * color_similarity
"""
import asyncio
import logging
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor
from ultralytics import YOLO

from backend.config import DATA_DIR
from backend.services.ffmpeg_service import extract_frame

logger = logging.getLogger(__name__)

# ---- 全局模型（懒加载） ----
_clip_model: CLIPModel | None = None
_clip_processor: CLIPProcessor | None = None
_yolo: YOLO | None = None
_device = "cpu"

# 混合评分权重
CLIP_WEIGHT = 0.7
COLOR_WEIGHT = 0.3
TORSO_RATIO = 0.6  # 人体框上部 60% 作为 torso


def _load_models():
    """懒加载 FashionCLIP + YOLO 模型"""
    global _clip_model, _clip_processor, _yolo, _device
    if _clip_model is not None:
        return

    # 设备选择
    if torch.backends.mps.is_available():
        _device = "mps"
    elif torch.cuda.is_available():
        _device = "cuda"
    else:
        _device = "cpu"

    model_name = "patrickjohncyh/fashion-clip"
    logger.info(f"加载 FashionCLIP 模型: {model_name} on {_device}...")
    _clip_model = CLIPModel.from_pretrained(model_name).to(_device)
    _clip_model.eval()
    _clip_processor = CLIPProcessor.from_pretrained(model_name)

    logger.info("加载 YOLO 模型: yolov8n.pt...")
    _yolo = YOLO("yolov8n.pt")

    logger.info("FashionCLIP + YOLO 模型加载完成")


# ---- 图像处理 ----

def _detect_person(image: Image.Image) -> tuple | None:
    """YOLO 检测人体，返回置信度最高的 person 框 (x1, y1, x2, y2)"""
    results = _yolo(image, classes=[0], verbose=False)
    boxes = results[0].boxes
    if len(boxes) == 0:
        return None
    best_idx = boxes.conf.argmax().item()
    box = boxes.xyxy[best_idx].cpu().numpy()
    return tuple(map(int, box))


def _crop_torso(image: Image.Image, box: tuple) -> Image.Image | None:
    """从 person 框裁剪上半身 torso 区域"""
    x1, y1, x2, y2 = box
    h = y2 - y1
    torso_y2 = y1 + int(h * TORSO_RATIO)

    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(image.width, x2)
    torso_y2 = min(image.height, torso_y2)

    if x2 <= x1 or torso_y2 <= y1:
        return None
    return image.crop((x1, y1, x2, torso_y2))


def _crop_center(image: Image.Image, ratio: float = 0.6) -> Image.Image:
    """中心裁剪 fallback（无法检测人体时）"""
    w, h = image.size
    new_w, new_h = int(w * ratio), int(h * ratio)
    left, top = (w - new_w) // 2, (h - new_h) // 2
    return image.crop((left, top, left + new_w, top + new_h))


def _get_roi(image: Image.Image) -> Image.Image:
    """获取感兴趣区域：优先 YOLO torso，fallback 中心裁剪"""
    person_box = _detect_person(image)
    if person_box:
        roi = _crop_torso(image, person_box)
        if roi is not None:
            return roi
    return _crop_center(image)


# ---- 特征提取 ----

def _to_tensor(out) -> torch.Tensor:
    """兼容 transformers 5.x: get_image_features 可能返回对象而非 Tensor"""
    if isinstance(out, torch.Tensor):
        return out
    # BaseModelOutputWithPooling → 取 pooler_output
    if hasattr(out, 'pooler_output') and out.pooler_output is not None:
        return out.pooler_output
    if hasattr(out, 'last_hidden_state'):
        return out.last_hidden_state[:, 0]  # CLS token
    raise TypeError(f"无法从 {type(out).__name__} 提取 tensor")


def _embed_image(image_path: str) -> np.ndarray:
    """计算单张图片的 FashionCLIP embedding（归一化）"""
    _load_models()
    img = Image.open(image_path).convert("RGB")
    inputs = _clip_processor(images=img, return_tensors="pt")
    inputs = {k: v.to(_device) for k, v in inputs.items()}
    with torch.no_grad():
        emb = _to_tensor(_clip_model.get_image_features(**inputs))
        emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu().numpy().flatten()


def _embed_images_batch(image_paths: list[str], batch_size: int = 32) -> np.ndarray:
    """批量计算图片 CLIP embeddings，带 YOLO torso 裁剪"""
    _load_models()
    all_embs = []

    for i in range(0, len(image_paths), batch_size):
        batch_paths = image_paths[i:i + batch_size]
        images = []

        for p in batch_paths:
            try:
                img = Image.open(p).convert("RGB")
                roi = _get_roi(img)
                images.append(roi)
            except Exception as e:
                logger.warning(f"图片加载失败: {p} — {e}")

        if not images:
            continue

        inputs = _clip_processor(images=images, return_tensors="pt", padding=True)
        inputs = {k: v.to(_device) for k, v in inputs.items()}
        with torch.no_grad():
            embs = _to_tensor(_clip_model.get_image_features(**inputs))
            embs = embs / embs.norm(dim=-1, keepdim=True)
        all_embs.append(embs.cpu().numpy())

    if not all_embs:
        return np.array([])
    return np.vstack(all_embs)


def _extract_color_feature(image_path: str) -> np.ndarray:
    """提取 HSV 颜色直方图特征（96 维: H/S/V 各 32 bins）"""
    img = cv2.imread(image_path)
    if img is None:
        return np.zeros(96, dtype=np.float32)

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    h_hist = cv2.calcHist([hsv], [0], None, [32], [0, 180]).flatten()
    s_hist = cv2.calcHist([hsv], [1], None, [32], [0, 256]).flatten()
    v_hist = cv2.calcHist([hsv], [2], None, [32], [0, 256]).flatten()

    # 归一化
    h_hist = h_hist / (h_hist.sum() + 1e-6)
    s_hist = s_hist / (s_hist.sum() + 1e-6)
    v_hist = v_hist / (v_hist.sum() + 1e-6)

    return np.concatenate([h_hist, s_hist, v_hist]).astype(np.float32)


def _batch_color_features(image_paths: list[str]) -> np.ndarray:
    """批量提取颜色特征"""
    features = []
    for p in image_paths:
        try:
            features.append(_extract_color_feature(p))
        except Exception:
            features.append(np.zeros(96, dtype=np.float32))
    return np.stack(features)


def _color_similarity(ref_color: np.ndarray, frame_colors: np.ndarray) -> np.ndarray:
    """计算颜色特征的余弦相似度"""
    ref_norm = ref_color / (np.linalg.norm(ref_color) + 1e-6)
    norms = np.linalg.norm(frame_colors, axis=1, keepdims=True) + 1e-6
    frame_normed = frame_colors / norms
    return frame_normed @ ref_norm


# ---- 主搜索函数 ----

async def find_similar_frames(
    sku_image_path: str,
    video_path: str,
    video_duration: float,
    sample_interval: float = 30.0,
    top_k: int = 10,
) -> list[dict]:
    """在视频中寻找与商品图最相似的帧（FashionCLIP + YOLO + HSV 混合评分）

    Args:
        sku_image_path: SKU 商品图路径（相对或绝对）
        video_path: 视频文件路径
        video_duration: 视频总时长（秒）
        sample_interval: 采样间隔（秒），默认 30s
        top_k: 返回最相似的前 K 帧

    Returns:
        [{ timestamp, similarity }] 按相似度降序
    """
    # 解析商品图路径
    if not Path(sku_image_path).is_absolute():
        sku_image_path = str(DATA_DIR / sku_image_path)

    if not Path(sku_image_path).exists():
        raise FileNotFoundError(f"商品图不存在: {sku_image_path}")

    # 生成采样时间点
    timestamps = []
    t = 0.0
    while t <= video_duration:
        timestamps.append(round(t, 1))
        t += sample_interval

    logger.info(
        f"CLIP 搜索: {len(timestamps)} 帧, 间隔 {sample_interval}s, "
        f"视频 {video_duration:.0f}s (FashionCLIP + YOLO + HSV)"
    )

    # 抽帧（竖屏 360x640，YOLO 需要合理分辨率）
    frame_paths: list[str | None] = []
    for ts in timestamps:
        try:
            path = await extract_frame(video_path, ts, width=360, height=640)
            frame_paths.append(path)
        except Exception as e:
            logger.warning(f"抽帧失败 @{ts}s: {e}")
            frame_paths.append(None)

    # 过滤成功的帧
    valid = [(ts, fp) for ts, fp in zip(timestamps, frame_paths) if fp]
    if not valid:
        return []

    valid_timestamps, valid_paths = zip(*valid)
    valid_paths_list = list(valid_paths)

    loop = asyncio.get_event_loop()

    # 并行计算: CLIP embedding + 颜色特征
    sku_emb = await loop.run_in_executor(None, _embed_image, sku_image_path)
    frame_embs = await loop.run_in_executor(None, _embed_images_batch, valid_paths_list)

    if frame_embs.size == 0:
        return []

    # 颜色特征
    sku_color = await loop.run_in_executor(None, _extract_color_feature, sku_image_path)
    frame_colors = await loop.run_in_executor(None, _batch_color_features, valid_paths_list)

    # CLIP 余弦相似度（已归一化，点积即余弦）
    clip_sim = frame_embs @ sku_emb

    # 颜色相似度
    color_sim = _color_similarity(sku_color, frame_colors)

    # 混合评分
    combined = CLIP_WEIGHT * clip_sim + COLOR_WEIGHT * color_sim

    # 取 top-K
    top_indices = np.argsort(combined)[::-1][:top_k]

    results = []
    for idx in top_indices:
        results.append({
            "timestamp": valid_timestamps[idx],
            "similarity": round(float(combined[idx]), 4),
        })

    logger.info(
        f"CLIP 搜索完成: top1={results[0]['similarity']:.4f} @ {results[0]['timestamp']:.0f}s"
        if results else "CLIP 搜索: 无结果"
    )

    return results
