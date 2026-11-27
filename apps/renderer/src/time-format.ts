/**
 * 时长格式化（修改 5 · D1）。
 *
 * 标签上显示「这一轮跑了多久」。三条约束：
 *  - 负数（时钟回退、先记结束再记开始）一律 0:00，不出现 `-0:03`；
 *  - 一分钟以内也给秒（`0:07`），否则用户看到 `0:00` 会以为没在跑；
 *  - 超过一小时进位成 `h:mm:ss`，不把 `72:31` 这种读数丢给用户。
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
