import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactItem, ArtifactListResult, FileReadResult } from "@oh-my-coding-pi/shared";
import FilePreview from "./FilePreview";
import Markdown from "./Markdown";
import { pickPreviewKind } from "./artifact-preview";

/**
 * 产物面板（参考 DAWN 的产物坞）。
 *
 * 2026-11-17 修改 1：点开不再跳到「文件」页签，而是本面板内换成预览。
 * 文件页签的目录、滚动、选中全程不动；要过去看目录结构时用头部的「在文件页签打开」。
 *
 * 三条来自 DAWN 的口径仍然成立：
 * - 分组按目录，文件名在前、类型徽标在后；
 * - 账本里有、盘上没有 → 显示「已不存在」，不偷偷删掉；
 * - 产出无法枚举的运行次数要显式说出来（「另有 N 次运行产出未知」）。
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
  onReveal,
}: {
  active: boolean;
  /** 主动跳到「文件」页签并预览（原来的行为，现在是次级出口） */
  onReveal: (path: string) => void;
}) {
  const [data, setData] = useState<ArtifactListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);

  // 预览状态（修改 1）：选中项 + 读到的内容；列表状态与滚动位置另存
  const [selected, setSelected] = useState<ArtifactItem | null>(null);
  const [file, setFile] = useState<FileReadResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);

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

  // 返回列表时恢复滚动位置：来回点开几个文件不至于每次都从头找
  useEffect(() => {
    if (!selected && listRef.current) listRef.current.scrollTop = scrollTopRef.current;
  }, [selected]);

  const open = useCallback(async (item: ArtifactItem) => {
    if (!item.exists) return;
    if (listRef.current) scrollTopRef.current = listRef.current.scrollTop;
    setSelected(item);
    setFile(null);
    setFileError(null);
    setFileLoading(true);
    try {
      const res = await window.api.readFile(item.path);
      setFile(res);
      if (res.error && res.kind !== "text" && res.kind !== "image") setFileError(res.error);
    } catch (err) {
      setFileError((err as Error).message);
    } finally {
      setFileLoading(false);
    }
  }, []);

  // Esc 关闭预览；只在面板可见且有选中项时接管
  useEffect(() => {
    if (!active || !selected) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selected]);

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

  if (selected) {
    const kind = file ? pickPreviewKind(selected.path, file.kind) : "none";
    return (
      <div className="art">
        <div className="art-preview-head">
          <button className="art-back" onClick={() => setSelected(null)} title="返回产物列表（Esc）">
            ← 列表
          </button>
          <span className="art-preview-name" title={selected.path}>
            {selected.name}
          </span>
          <span className="art-preview-meta">
            {formatSize(selected.size)}
            {selected.mtime ? ` · ${new Date(selected.mtime).toLocaleString()}` : ""}
            {!selected.exists ? " · 已不存在" : ""}
          </span>
          <button className="art-btn" onClick={() => onReveal(selected.path)}>
            在文件页签打开
          </button>
        </div>
        <div className="art-preview-body">
          {fileLoading && <div className="art-preview-note">读取中…</div>}
          {!fileLoading && fileError && <div className="art-preview-note">{fileError}</div>}
          {!fileLoading && !fileError && file && kind === "markdown" && (
            <div className="art-preview-md">
              <Markdown text={file.text ?? ""} />
            </div>
          )}
          {!fileLoading && !fileError && file && kind === "none" && (
            <div className="art-preview-note">
              {file.error || "这个格式不支持预览"}
              <div style={{ marginTop: 8 }}>
                <button className="art-btn" onClick={() => onReveal(selected.path)}>
                  在文件页签打开
                </button>
              </div>
            </div>
          )}
          {!fileLoading && !fileError && file && (kind === "image" || kind === "table" || kind === "text") && (
            <FilePreview result={file} />
          )}
        </div>
        <div className="art-foot">
          {selected.tool ? `来自 ${selected.tool}` : ""}
          {selected.ts ? ` · ${new Date(selected.ts).toLocaleString()}` : ""}
        </div>
      </div>
    );
  }

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
        <div className="art-groups" ref={listRef}>
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
                      onClick={() => void open(a)}
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
