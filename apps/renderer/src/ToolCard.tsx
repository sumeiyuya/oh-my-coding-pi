import { useState } from "react";
import { foldOutput, formatDuration, toolCommandLine } from "./tool-summary";

/**
 * 单个工具调用卡片（不成组时用它）。
 *
 * 与成组时的行保持同一套说法：工具名 + 一行命令 + 耗时；输出默认只显示前 8 行，
 * 并写明"还有 N 行"——不靠省略号暗示。
 */
export default function ToolCard({
  name,
  args,
  done,
  result,
  startedAt,
  endedAt,
  isError,
  interrupted,
}: {
  name: string;
  args: string;
  done: boolean;
  result?: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  interrupted?: boolean;
}) {
  // 单条报错默认展开：只有一个工具时，把它藏起来等于把唯一的线索藏起来
  const [open, setOpen] = useState(Boolean(isError) && !interrupted);
  const [full, setFull] = useState(false);
  const ms =
    startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : undefined;
  const failed = Boolean(isError) && !interrupted;
  const folded = foldOutput(result, full);

  return (
    <div className={`msg tool-card ${done ? "done" : "running"}${failed ? " failed" : ""}`}>
      <button
        type="button"
        className="tool-card-head"
        onClick={() => setOpen((v) => !v)}
        disabled={!result}
        title={result ? (open ? "收起输出" : "展开输出") : "暂无输出"}
        aria-expanded={open}
      >
        <span className="dot" data-done={done} data-error={failed ? "1" : undefined} />
        <code>{name}</code>
        <span className="args">{toolCommandLine({ name, args })}</span>
        {interrupted && <span className="tr-note">已停止</span>}
        {ms !== undefined && <span className="tr-dur">{formatDuration(ms)}</span>}
        {result && <span className="tool-toggle">{open ? "收起" : "输出"}</span>}
      </button>
      {open && folded && (
        <div className="tool-row-body">
          <pre className="tool-result">{folded.text}</pre>
          {folded.hidden > 0 && (
            <button type="button" className="tr-more" onClick={() => setFull(true)}>
              还有 {folded.hidden} 行
            </button>
          )}
        </div>
      )}
    </div>
  );
}
