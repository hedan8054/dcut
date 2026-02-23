import type { FrameData } from '@/hooks/use-multi-res-frames'

export interface FrameItem { kind: 'frame'; frame: FrameData }
export interface BagItem {
  kind: 'bag'
  sampledFrames: FrameData[]  // 降采样帧（高一档间隔，用于渲染）
  frameCount: number          // 原始帧数（用于 badge 显示）
  startSec: number            // 选区起点
  endSec: number              // 选区终点
  slots: number               // = sampledFrames.length（动态）
}
export type DisplayItem = FrameItem | BagItem

export const BAG_THRESHOLD = 6    // 选区 > 6 帧才压缩，给用户更多橙色 overlay 预览时间
export const BAG_SAMPLE_SEC = 10  // 压缩采样间隔（秒），先 hardcode 后续可微调
