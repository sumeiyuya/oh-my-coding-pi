/**
 * 打开会话时的「先看历史、后解锁输入」（修改 5 · S5b）。
 *
 * 背景：`session:open` 可能要 spawn 一个 pi 进程并等它就绪（几十秒）。
 * 旧做法是**等它回来再画**，于是点一下就是一段空白。现在先把主进程转录中枢里的
 * 快照画出来（只读内存，不动进程），等槽就绪后再用真内容接管。
 *
 * 这里只做一件事：决定「这一刻该画哪份」——预览还是那个槽自己的桶。
 * 抽出来是因为它有两条容易写错的边界：**预览属于别的文件**（用户已经切走了）
 * 和**预览还没到就切走**。
 */
export interface TranscriptPreview {
  /** 这份快照属于哪个会话文件（绝对路径） */
  file: string;
  items: unknown[];
}

/**
 * @param preview    打开期间抓到的中枢快照（可能为 null）
 * @param currentFile 当前显示的会话文件
 * @param bucket     当前激活槽自己的消息桶
 */
export function pickMessages<T>(
  preview: TranscriptPreview | null,
  currentFile: string | null,
  bucket: T[],
): unknown[] {
  if (!preview || !currentFile) return bucket;
  if (preview.file !== currentFile) return bucket;
  return preview.items.length > 0 ? preview.items : bucket;
}
