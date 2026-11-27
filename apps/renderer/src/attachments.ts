/**
 * 待发图片的合并规则（修改一）。
 *
 * 为什么单独抽出来：粘贴是异步的（要先 `file.arrayBuffer()`），旧写法在
 * `await` 之后拿的是**调用那一刻的列表快照**，两次粘贴挨得近时后一次会把
 * 前一次覆盖掉——现象就是"只能粘一张"。合并规则写成纯函数，
 * 再配合函数式更新，才谈得上"不丢图"。
 */

export interface PendingImage {
  id: string;
  data: string;
  mimeType: string;
  /** 原始字节数（用于总量判断与界面显示） */
  size?: number;
}

export interface ImageLimits {
  /** 最多几张 */
  maxCount: number;
  /** 单张上限（字节） */
  maxBytes: number;
  /** 合计上限（字节） */
  totalBytes: number;
}

export interface MergeResult {
  list: PendingImage[];
  /** 被拒绝的项：给界面一句人话，不静默丢 */
  rejected: Array<{ reason: string; name?: string }>;
}

/** base64 字符长度 → 原始字节数（UI 只用来显示与估算总量） */
export function bytesOfBase64(data: string): number {
  return Math.ceil((data.length * 3) / 4);
}

function sizeOf(image: PendingImage): number {
  return image.size ?? bytesOfBase64(image.data);
}

/**
 * 把新一批图片并进已有列表。
 *
 * - **去重**按内容（同一张图重复粘贴不该叠两份）；
 * - 张数、单张、合计三个上限都在这里判，顺序是：单张 → 张数 → 合计；
 * - 超限的写进 `rejected`，由调用方提示——"静默丢"比"多一张"更糟。
 */
export function mergeImages(
  current: PendingImage[],
  incoming: PendingImage[],
  limits: ImageLimits,
): MergeResult {
  const list = [...current];
  const rejected: MergeResult["rejected"] = [];
  const seen = new Set(list.map((item) => `${item.mimeType}:${item.data}`));

  for (const image of incoming) {
    const key = `${image.mimeType}:${image.data}`;
    if (seen.has(key)) {
      rejected.push({ reason: "重复的图片，已跳过" });
      continue;
    }
    const size = sizeOf(image);
    if (size > limits.maxBytes) {
      rejected.push({ reason: `单张超过 ${Math.round(limits.maxBytes / 1024 / 1024)} MB` });
      continue;
    }
    if (list.length >= limits.maxCount) {
      rejected.push({ reason: `最多 ${limits.maxCount} 张` });
      continue;
    }
    const total = list.reduce((sum, item) => sum + sizeOf(item), 0);
    if (total + size > limits.totalBytes) {
      rejected.push({ reason: `合计超过 ${Math.round(limits.totalBytes / 1024 / 1024)} MB` });
      continue;
    }
    list.push(image);
    seen.add(key);
  }

  return { list, rejected };
}
