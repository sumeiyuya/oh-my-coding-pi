import { useCallback, useEffect, useMemo, useState } from "react";
import type { ArtifactItem, ArtifactListResult } from "@oh-my-coding-pi/shared";

/**
 * 产物面板（参考 DAWN 的产物坞）。
 *
 * 三条来自 DAWN 的口径：
 * - 分组按目录，文件名在前、类型徽标在后；
 * - 账本里有、盘上没有 → 显示「已不存在」，不偷偷删掉；
 * - 产出无法枚举的运行次数要显式说出来（「另有 N 次运行产出未知」），
 *   不许把「不知道」画成「没有」。
 */

const KIND_LABEL: Record<string, string> = {
  code: "CODE",
  markdown: "MARKDOWN",
  text: "TEXT",
  data: "DATA",
  image: "IMAGE",
  other: "FILE",
};

function formatSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ArtifactsPane({
  active,
  onOpen,
}: {
  active: boolean;
  onOpen: (path: string) => void;
}) {
  const [data, setData] = useState<ArtifactListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await window.api.listArtifacts());
    } catch (err) {
      setData({
        artifacts: [],
        unknownRuns: 0,
        observed: 0,
        scannedAt: new Date().toISOString(),
        error: (err as Error).message,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  // 只在面板真的可见时刷新，避免每切一次页签都扫盘
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (data?.artifacts ?? []).filter(
      (a) => (!q || a.path.toLowerCase().includes(q)) && (!onlyMissing || !a.exists),
    );
    const map = new Map<string, ArtifactItem[]>();
    for (const a of items) {
      const key = a.dir || "(工作区根)";
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, [data, query, onlyMissing]);

  const total = data?.artifacts.length ?? 0;
  const missing = (data?.artifacts ?? []).filter((a) => !a.exists).length;

  return (
    <div className="art">
      <div className="art-head">
        <b>结果</b>
        <span className="art-count">{total}</span>
        <span className="art-spacer" />
        <input
          className="art-search"
          type="search"
          value={query}
          placeholder="过滤路径…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className={`art-btn ${onlyMissing ? "on" : ""}`} onClick={() => setOnlyMissing((v) => !v)}>
          仅已失效
        </button>
        <button className="art-btn" onClick={() => void load()} disabled={loading}>
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {data?.error && <div className="art-error">{data.error}</div>}

      {data && data.unknownRuns > 0 && (
        <div className="art-unknown">
          另有 {data.unknownRuns} 次运行产出未知
          <span className="art-hint">（bash / run_code 写了什么，账本看不见）</span>
        </div>
      )}

      {!data || total === 0 ? (
        <div className="art-empty">
          <b>这个会话还没有产物</b>
          <p>写文件类工具的产出会记在账本里；figures/ 与 results/ 另外扫一遍。</p>
        </div>
      ) : (
        <div className="art-groups">
          {groups.map(([dir, items]) => (
            <section key={dir} className="art-group">
              <div className="art-group-head">
                <span title={dir}>{dir}</span>
                <span className="art-group-count">{items.length}</span>
              </div>
              <ul className="art-list">
                {items.map((a) => (
                  <li key={a.path}>
                    <button
                      className={`art-row ${a.exists ? "" : "gone"}`}
                      title={a.path}
                      onClick={() => a.exists && onOpen(a.path)}
                      disabled={!a.exists}
                    >
                      <span className="art-name">{a.name}</span>
                      <span className={`art-kind k-${a.kind}`}>{KIND_LABEL[a.kind] ?? "FILE"}</span>
                      {!a.exists && <span className="art-gone">已不存在</span>}
                      {a.exists && a.size != null && <span className="art-size">{formatSize(a.size)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {data && (
        <div className="art-foot">
          扫描于 {new Date(data.scannedAt).toLocaleTimeString()}
          {data.observed > 0 ? ` · 其中 ${data.observed} 个来自目录扫描` : ""}
          {missing > 0 ? ` · ${missing} 个已失效` : ""}
        </div>
      )}
    </div>
  );
}
