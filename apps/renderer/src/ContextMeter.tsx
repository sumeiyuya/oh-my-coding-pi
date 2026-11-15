import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionStats } from "@oh-my-coding-pi/shared";
import { readMeter } from "./context-meter";

export default function ContextMeter({
  sessionKey,
  busy,
}: {
  /** 当前会话文件；变了就重取 */
  sessionKey: string | null;
  /** 这一轮是否在跑：从 true 变 false 时重取 */
  busy: boolean;
}) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const wasBusy = useRef(busy);

  const load = useCallback(async () => {
    try {
      setStats((await window.api.getStats()) as SessionStats);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 换会话：取一次
  useEffect(() => {
    setStats(null);
    setError("");
    if (sessionKey) void load();
  }, [sessionKey, load]);

  // 这一轮结束：取一次（不做轮询）
  useEffect(() => {
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
  }, [busy, load]);

  // 打开弹层：取一次
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const reading = readMeter(stats, error || undefined);

  return (
    <div className="ctx-meter" ref={box} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        className="ctx-meter-trigger"
        data-tone={reading.tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="上下文用量"
        onClick={() => setOpen((v) => !v)}
      >
        上下文 {reading.value}
      </button>

      {open && (
        <div className="ctx-meter-pop" role="dialog" aria-label="上下文用量">
          <div className="ctx-meter-head">
            <b>上下文</b>
            <span className="muted">{reading.value}</span>
          </div>
          {reading.detail.map((line, i) => (
            <div key={i} className="ctx-meter-line">
              {line}
            </div>
          ))}
          <div className="ctx-meter-foot">
            {reading.canCompact ? "压缩由 pi 自动执行；这里只读不写。" : "外部 agent 自己管上下文。"}
          </div>
        </div>
      )}
    </div>
  );
}
