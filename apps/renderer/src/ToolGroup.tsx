import { useEffect, useState } from "react";
import {
  foldOutput,
  formatDuration,
  groupSentence,
  runningLabel,
  summarizeTools,
  toolCommandLine,
  type ToolItem,
} from "./tool-summary";

/**
 * 一组连续的工具调用（S2）。
 *
 * 借自 DAWN 的 `ToolGroupRow`：
 * - 默认**收起**；运行中强制展开，跑完再交回给用户；
 * - 失败只在组头红字写「N 条失败」，点开才看是哪条；
 * - 总时长缺一段就不显示；
 * - 正在跑的组头显示「正在运行 · <可执行名>」+ 转圈。
 */

export default function ToolGroup({ tools }: { tools: ToolItem[] }) {
  const summary = summarizeTools(tools);
  const [open, setOpen] = useState(false);

  // 运行中必须看得见：一开跑就展开；跑完保持原来的展开状态（不清洗用户的选择）
  useEffect(() => {
    if (summary.running) setOpen(true);
  }, [summary.running?.id]);

  const running = summary.running;
  const sentence = groupSentence(tools);
  const showElapsed = !running && summary.totalMs !== undefined && summary.totalMs >= 1000;

  return (
    <div className={`tool-group${open ? " open" : ""}${running ? " running" : ""}`}>
      <button
        type="button"
        className="tool-group-head"
        aria-expanded={open}
        onClick={() => {
          if (running) return; // 跑着的时候不允许收起
          setOpen((v) => !v);
        }}
        title={running ? "正在运行，跑完可收起" : open ? "收起这一组" : "展开这一组"}
      >
        <span className="tg-caret" aria-hidden="true">▶</span>
        {running ? (
          <span className="tg-spin" aria-label="运行中" />
        ) : (
          <span className={`tg-mark ${summary.failures ? "bad" : "ok"}`} aria-hidden="true">
            {summary.failures ? "!" : "✓"}
          </span>
        )}
        <span className="tg-say">
          {running ? (
            <>
              正在运行 · <code>{runningLabel(running)}</code>
            </>
          ) : (
            sentence || `调用了 ${summary.count} 次工具`
          )}
        </span>
        {summary.failures > 0 && <span className="tg-fail">· {summary.failures} 条失败</span>}
        {showElapsed && <span className="tg-elapsed">共 {formatDuration(summary.totalMs!)}</span>}
      </button>

      {open && (
        <div className="tool-group-body">
          {tools.map((t) => (
            <ToolRow key={t.id} item={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const ms =
    item.startedAt !== undefined && item.endedAt !== undefined
      ? Math.max(0, item.endedAt - item.startedAt)
      : undefined;
  const folded = foldOutput(item.result, full);
  const canOpen = Boolean(item.result) || item.isError;

  return (
    <div className={`tool-row${open ? " open" : ""}${item.isError && !item.interrupted ? " failed" : ""}`}>
      <button
        type="button"
        className="tool-row-head"
        aria-expanded={open}
        disabled={!canOpen}
        onClick={() => setOpen((v) => !v)}
        title={canOpen ? (open ? "收起输出" : "查看输出") : "没有输出"}
      >
        <span className="tr-caret" aria-hidden="true">{canOpen ? "▶" : ""}</span>
        <span className={`tg-mark ${item.isError && !item.interrupted ? "bad" : item.done ? "ok" : "wait"}`} aria-hidden="true">
          {item.isError && !item.interrupted ? "!" : item.done ? "✓" : "·"}
        </span>
        <span className="tr-tool">{item.name}</span>
        <span className="tr-cmd">{toolCommandLine(item)}</span>
        {item.interrupted && <span className="tr-note">已停止</span>}
        {ms !== undefined && <span className="tr-dur">{formatDuration(ms)}</span>}
      </button>
      {open && canOpen && (
        <div className="tool-row-body">
          {folded && <pre>{folded.text}</pre>}
          {folded && folded.hidden > 0 && (
            <button type="button" className="tr-more" onClick={() => setFull(true)}>
              还有 {folded.hidden} 行
            </button>
          )}
        </div>
      )}
    </div>
  );
}
