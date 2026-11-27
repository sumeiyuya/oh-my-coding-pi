/**
 * 发送门的纯逻辑（修改 5 · 修复 "别的会话在跑，这里发不出去"）。
 *
 * 起因：`submitPhase` 曾经是一个**全局** state。事件按 runtime 分流，
 * 后台会话的 `agent_settled` 只进它自己的桶，于是这个全局值永远停在
 * "streaming"——切到另一个会话，发送按钮就是灰的，而且没有任何提示。
 *
 * 现在阶段按 runtime 记账（`phaseFor`），发送门也抽成纯函数：
 * 用测试钉住「别的会话在跑，不影响这一段」这条不变式。
 */
export type SubmitPhase = "idle" | "submitting" | "accepted" | "preparing" | "running" | "streaming";

/** 某个会话此刻的阶段；没有记录 = 空闲 */
export function phaseFor(
  byRuntime: Record<string, SubmitPhase>,
  runtimeId: string,
): SubmitPhase {
  return byRuntime[runtimeId] ?? "idle";
}

/**
 * 为什么发不出去（null = 可以发）。
 *
 * 顺序有意：先说"这段还没连上/在排队"，再说"它自己在跑"。
 * 这些原因分别对应界面上不同的提示，不能合并成一句"发送失败"。
 */
export type SendBlock =
  | "empty"
  | "queued"
  | "opening"
  | "not-ready"
  | "busy"
  | "in-flight"
  | null;

export function sendBlockReason(input: {
  text: string;
  /** 当前这段会话自己的阶段（不是全局的） */
  phase: SubmitPhase;
  /** 当前这段会话自己在跑一轮 */
  busy: boolean;
  /** 它的槽是否就绪 */
  slotReady: boolean;
  /** 正在等名额 */
  queued: boolean;
  /** 正在打开（还没有可用的槽） */
  opening: boolean;
}): SendBlock {
  if (!input.text.trim()) return "empty";
  if (input.queued) return "queued";
  if (input.opening) return "opening";
  if (!input.slotReady) return "not-ready";
  if (input.busy) return "busy";
  if (input.phase !== "idle") return "in-flight";
  return null;
}
