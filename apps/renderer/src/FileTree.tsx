import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry, FileListResult } from "@oh-my-coding-pi/shared";

/**
 * 右坞「文件」页的树形浏览器（方案：ui-file-tree）。
 *
 * 纪律：
 * - 数据仍只走 fs:list，按目录懒加载；展开过的目录在组件内缓存，切页签不丢；
 * - 展开状态由 App 持有并持久化（换工作区才重置），组件不自己写 localStorage；
 * - 只读：点文件只做预览，不做任何写操作。
 */

interface FileTreeProps {
  /** 工作区目录名（根节点文字） */
  rootName: string;
  expanded: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  load: (path: string) => Promise<FileListResult>;
}

type Row =
  | { kind: "entry"; entry: FileEntry; depth: number }
  | { kind: "note"; text: string; depth: number; tone?: "error" };

function FolderIcon() {
  return (
    <svg className="tree-ico dir" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.6 4.1c0-.6.5-1 1-1h3l1.1 1.4h6.7c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.6c-.5 0-1-.4-1-1z"
        fill="currentColor"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg className="tree-ico" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 1.8h6l3 3v9.4c0 .5-.4.9-.9.9H3.5c-.5 0-.9-.4-.9-.9V2.7c0-.5.4-.9.9-.9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9.5 1.9v3.2h3.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export default function FileTree({
  rootName,
  expanded,
  selected,
  onToggle,
  onSelect,
  load,
}: FileTreeProps) {
  const [cache, setCache] = useState<Map<string, FileEntry[]>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [truncated, setTruncated] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [active, setActive] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  /** 同一目录并发展开只发一次请求 */
  const inflight = useRef(new Set<string>());
  const cacheRef = useRef(new Map<string, FileEntry[]>());

  const ensure = useCallback(
    async (path: string) => {
      if (cacheRef.current.has(path) || inflight.current.has(path)) return;
      inflight.current.add(path);
      setLoading((prev) => new Set(prev).add(path));
      try {
        const res = await load(path);
        if (res.error) {
          setErrors((prev) => new Map(prev).set(path, res.error ?? "读取失败"));
        } else {
          cacheRef.current.set(path, res.entries);
          setCache(new Map(cacheRef.current));
          if (res.truncated) setTruncated((prev) => new Set(prev).add(path));
        }
      } catch (err) {
        setErrors((prev) =>
          new Map(prev).set(path, err instanceof Error ? err.message : "读取失败"),
        );
      } finally {
        inflight.current.delete(path);
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [load],
  );

  // 展开的目录才加载（根 "" 总是展开，因此首屏只读一层）
  useEffect(() => {
    expanded.forEach((path) => void ensure(path));
  }, [expanded, ensure]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      { kind: "entry", entry: { name: rootName, path: "", type: "dir" }, depth: 0 },
    ];
    const walk = (path: string, depth: number) => {
      const error = errors.get(path);
      if (error) {
        out.push({ kind: "note", text: `读不到：${error}`, depth, tone: "error" });
        return;
      }
      const entries = cache.get(path);
      if (!entries) {
        if (loading.has(path)) out.push({ kind: "note", text: "读取中…", depth });
        return;
      }
      if (entries.length === 0) out.push({ kind: "note", text: "空目录", depth });
      for (const entry of entries) {
        out.push({ kind: "entry", entry, depth });
        if (entry.type === "dir" && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
      if (truncated.has(path)) out.push({ kind: "note", text: "只列出前 1000 条", depth });
    };
    if (expanded.has("")) walk("", 1);
    return out;
  }, [cache, errors, expanded, loading, rootName, truncated]);

  const visible = useMemo(
    () => rows.flatMap((row) => (row.kind === "entry" ? [row.entry] : [])),
    [rows],
  );

  // 选中项被外部改（产物 reveal）或展开收起后，焦点行跟着回到可见范围
  useEffect(() => {
    if (visible.some((entry) => entry.path === active)) return;
    const next = selected && visible.some((entry) => entry.path === selected) ? selected : "";
    setActive(next);
  }, [visible, selected, active]);

  useEffect(() => {
    rowRefs.current.get(active)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const indexOf = (path: string) => visible.findIndex((entry) => entry.path === path);

  function activate(path: string) {
    setActive(path);
    rowRefs.current.get(path)?.focus({ preventScroll: true });
  }

  function openEntry(entry: FileEntry) {
    if (entry.type === "dir") onToggle(entry.path);
    else onSelect(entry.path);
  }

  function parentOf(path: string): string | null {
    if (path === "") return null;
    const cut = path.lastIndexOf("/");
    return cut <= 0 ? "" : path.slice(0, cut);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (visible.length === 0) return;
      const next = e.key === "ArrowDown" ? Math.min(visible.length - 1, i + 1) : Math.max(0, i - 1);
      activate(visible[next]!.path);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (visible.length === 0) return;
      activate(visible[e.key === "Home" ? 0 : visible.length - 1]!.path);
      return;
    }
    const current = i >= 0 ? visible[i] : undefined;
    if (!current) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (current.type === "dir" && !expanded.has(current.path)) {
        onToggle(current.path);
        return;
      }
      // 已展开：进入第一个子项（flatten 里紧跟当前行的下一条 entry 就是它）
      const next = visible[i + 1];
      if (next && next.path.startsWith(current.path === "" ? "" : current.path + "/")) {
        activate(next.path);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (current.type === "dir" && expanded.has(current.path)) {
        onToggle(current.path);
        return;
      }
      const parent = parentOf(current.path);
      if (parent !== null && indexOf(parent) >= 0) activate(parent);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openEntry(current);
    }
  }

  return (
    <div
      className="file-tree"
      ref={boxRef}
      role="tree"
      aria-label="工作区文件树"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (indexOf(active) < 0) setActive(visible[0]?.path ?? "");
      }}
    >
      {rows.map((row) => {
        if (row.kind === "note") {
          return (
            <div
              key={`note-${row.depth}-${row.text}`}
              className={`tree-note ${row.tone === "error" ? "error" : ""}`}
              style={{ paddingLeft: 6 + row.depth * 16 + 19 }}
            >
              {row.text}
            </div>
          );
        }
        const { entry, depth } = row;
        const isDir = entry.type === "dir";
        const open = isDir && expanded.has(entry.path);
        return (
          <button
            key={entry.path || "__root__"}
            type="button"
            role="treeitem"
            aria-expanded={isDir ? open : undefined}
            aria-selected={entry.path === selected}
            className={[
              "tree-row",
              isDir ? "dir" : "file",
              entry.path === "" ? "root" : "",
              entry.path === selected ? "selected" : "",
              entry.path === active ? "active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ paddingLeft: 6 + depth * 16 }}
            title={entry.path || rootName}
            ref={(el) => {
              if (el) rowRefs.current.set(entry.path, el);
              else rowRefs.current.delete(entry.path);
            }}
            onClick={() => {
              setActive(entry.path);
              boxRef.current?.focus({ preventScroll: true });
              openEntry(entry);
            }}
          >
            <span className={`tree-caret ${isDir ? (open ? "open" : "") : "blank"}`} aria-hidden="true" />
            {isDir ? <FolderIcon /> : <FileIcon />}
            <span className="tree-name">{entry.name}</span>
            {entry.symlink && <span className="tree-link">↗</span>}
            {!isDir && entry.size !== undefined && (
              <span className="tree-size">{formatTreeSize(entry.size)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatTreeSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
