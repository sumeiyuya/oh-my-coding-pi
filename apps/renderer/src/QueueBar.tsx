import type { QueueSnapshot } from "./queue";

/**
 * 待发条（修改 2）：运行中发出的消息先排队，每条可以改投递方向。
 *
 * 参考 DAWN 的「待发 · N / 排队中 / 调整方向 / 新增会话 / 取回」。
 * 「到坞里问」没做——右坞没有对话容器，硬做要新开一套会话路由。
 */
export default function QueueBar({
  queue,
  onRedirect,
  onNewSession,
  onTakeBack,
}: {
  queue: QueueSnapshot;
  onRedirect: (index: number) => void;
  onNewSession: (index: number) => void;
  onTakeBack: () => void;
}) {
  const items = [
    ...queue.steering.map((text) => ({ text, steering: true })),
    ...queue.followUp.map((text) => ({ text, steering: false })),
  ];
  if (!items.length) return null;
  const shown = items.slice(0, 3);
  const rest = items.length - shown.length;

  return (
    <div className="queue-bar" aria-label="待发消息">
      <div className="queue-head">
        <b>待发 · {items.length}</b>
        <span className="queue-state">排队中</span>
        <span className="queue-spacer" />
        <button className="queue-act" onClick={onTakeBack}>
          全部取回
        </button>
      </div>
      {shown.map((item, index) => (
        <div className="queue-item" key={`${index}-${item.text.slice(0, 8)}`}>
          <span className={`queue-idx ${item.steering ? "steer" : ""}`}>
            {index + 1}
            {item.steering ? " 转向" : ""}
          </span>
          <span className="queue-text" title={item.text}>
            {item.text.replace(/\s+/g, " ").slice(0, 120)}
          </span>
          <button className="queue-act" onClick={() => onRedirect(index)} title="立刻作为转向送达">
            调整方向
          </button>
          <button className="queue-act" onClick={() => onNewSession(index)} title="这一轮结束后新开会话并发送">
            新增会话
          </button>
        </div>
      ))}
      {rest > 0 && <div className="queue-more">还有 {rest} 条…</div>}
    </div>
  );
}
