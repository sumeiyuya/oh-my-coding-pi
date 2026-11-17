import { useCallback, useEffect, useRef, useState } from "react";
import type { KernelRunEvent, NotebookCell } from "@oh-my-coding-pi/shared";

type Output =
  | { kind: "text"; text: string }
  | { kind: "image"; data: string }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

type Cell = NotebookCell & { outputs: Output[] };

function newCell(language: "python" | "r" = "python"): Cell {
  return {
    id: `cell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    language,
    code: "",
    outputs: [],
  };
}

export default function Notebook() {
  const [cells, setCells] = useState<Cell[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [runningLang, setRunningLang] = useState<"python" | "r">("python");
  const [variables, setVariables] = useState<{ python: string[]; r: string[] }>({
    python: [],
    r: [],
  });
  const [saved, setSaved] = useState(true);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 变量刷新合并：连续执行多格时不要每格都问两次内核 */
  const variablesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    loaded.current = false;
    try {
      const list = await window.api.loadNotebook();
      setCells(list.map((c) => ({ ...c, outputs: [] })));
    } catch {
      setCells([newCell()]);
    }
    loaded.current = true;
  }, []);

  useEffect(() => {
    void load();
    const offWorkspace = window.api.onWorkspace(() => {
      void load();
    });
    return offWorkspace;
  }, [load]);

  useEffect(() => {
    if (!loaded.current) return;
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const payload: NotebookCell[] = cells.map((c) => ({
        id: c.id,
        language: c.language,
        code: c.code,
      }));
      window.api
        .saveNotebook(payload)
        .then(() => setSaved(true))
        .catch(() => setSaved(false));
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [cells]);

  useEffect(() => {
    const off = window.api.onKernelEvent((ev: KernelRunEvent) => {
      setCells((prev) =>
        prev.map((cell) => {
          if (cell.id !== ev.runId) return cell;
          const outputs = [...cell.outputs];
          if (ev.ev === "stream") {
            const last = outputs[outputs.length - 1];
            if (last && last.kind === "text") {
              outputs[outputs.length - 1] = { kind: "text", text: last.text + (ev.text ?? "") };
            } else {
              outputs.push({ kind: "text", text: ev.text ?? "" });
            }
          } else if (ev.ev === "display" && ev.mime === "image/png" && ev.data) {
            outputs.push({ kind: "image", data: ev.data });
          } else if (ev.ev === "display" && ev.mime === "text/plain" && ev.text) {
            if (!ev.text.startsWith("<Figure")) {
              const last = outputs[outputs.length - 1];
              if (last && last.kind === "text") {
                outputs[outputs.length - 1] = { kind: "text", text: last.text + ev.text };
              } else {
                outputs.push({ kind: "text", text: ev.text });
              }
            }
          } else if (ev.ev === "error") {
            outputs.push({
              kind: "error",
              ename: ev.ename ?? "Error",
              evalue: ev.evalue ?? "",
              traceback: ev.traceback ?? [],
            });
          }
          return { ...cell, outputs };
        }),
      );
      if (ev.ev === "result") {
        setRunningId(null);
        // 300 ms 合并：批量执行时只在末尾问一次，避免每格两次 IPC
        if (variablesTimer.current) clearTimeout(variablesTimer.current);
        variablesTimer.current = setTimeout(() => {
          variablesTimer.current = null;
          Promise.all([window.api.getVariables("python"), window.api.getVariables("r")])
            .then(([python, r]) => setVariables({ python, r }))
            .catch(() => undefined);
        }, 300);
      }
    });
    return () => {
      off();
      if (variablesTimer.current) {
        clearTimeout(variablesTimer.current);
        variablesTimer.current = null;
      }
    };
  }, []);

  async function run(cell: Cell) {
    if (runningId) return;
    setRunningId(cell.id);
    setRunningLang(cell.language);
    setCells((prev) =>
      prev.map((c) => (c.id === cell.id ? { ...c, outputs: [] } : c)),
    );
    const ok = await window.api
      .runCell(cell.id, cell.code, cell.language)
      .catch(() => false);
    if (!ok) {
      setCells((prev) =>
        prev.map((c) =>
          c.id === cell.id
            ? {
                ...c,
                outputs: [
                  ...c.outputs,
                  { kind: "error", ename: "KernelError", evalue: "执行失败", traceback: [] },
                ],
              }
            : c,
        ),
      );
      setRunningId(null);
    }
  }

  async function interrupt() {
    await window.api.interruptKernel(runningLang).catch(() => undefined);
  }

  async function restart(language: "python" | "r") {
    if (!confirm(`重启 ${language} 内核会丢失该语言的所有变量，确定？`)) return;
    await window.api.restartKernel(language).catch(() => undefined);
    setCells((prev) =>
      prev.map((c) =>
        c.language === language ? { ...c, outputs: [] } : c,
      ),
    );
    setRunningId(null);
    await refreshVariables();
  }

  async function refreshVariables() {
    const [python, r] = await Promise.all([
      window.api.getVariables("python").catch(() => []),
      window.api.getVariables("r").catch(() => []),
    ]);
    setVariables({ python, r });
  }

  function updateCode(id: string, code: string) {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, code } : c)));
  }

  function removeCell(id: string) {
    setCells((prev) => prev.filter((c) => c.id !== id));
  }

  function updateLanguage(id: string, language: "python" | "r") {
    setCells((prev) => prev.map((c) => (c.id === id ? { ...c, language } : c)));
  }

  return (
    <div className="notebook">
      <div className="nb-toolbar">
        <button onClick={() => setCells((prev) => [...prev, newCell("python")])}>＋ Py</button>
        <button onClick={() => setCells((prev) => [...prev, newCell("r")])}>＋ R</button>
        <button onClick={interrupt} disabled={!runningId}>
          中断
        </button>
        <button onClick={() => restart("python")}>重启 Py</button>
        <button onClick={() => restart("r")}>重启 R</button>
        <button onClick={refreshVariables}>变量</button>
        <span className={`nb-save ${saved ? "ok" : ""}`}>{saved ? "已保存" : "保存中…"}</span>
        <span className="nb-hint" title="只保存 cell 代码；文本与图像输出不入盘，重开需重新运行">
          输出不保存，重开需重跑
        </span>
        <span className="nb-vars">
          {variables.python.map((v) => <code key={"py-" + v}>py:{v}</code>)}
          {variables.r.map((v) => <code key={"r-" + v}>r:{v}</code>)}
          {variables.python.length + variables.r.length === 0 && "无变量"}
        </span>
      </div>

      {cells.map((cell, index) => (
        <div className="nb-cell" key={cell.id}>
          <div className="nb-head">
            <select
              className="nb-lang"
              value={cell.language}
              onChange={(e) => updateLanguage(cell.id, e.target.value as "python" | "r")}
            >
              <option value="python">python</option>
              <option value="r">r</option>
            </select>
            <span className="nb-index">[{index + 1}]</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => run(cell)} disabled={!!runningId}>
              {runningId === cell.id ? "运行中…" : "运行"}
            </button>
            <button className="ghost" onClick={() => removeCell(cell.id)}>
              删除
            </button>
          </div>
          <textarea
            value={cell.code}
            onChange={(e) => updateCode(cell.id, e.target.value)}
            spellCheck={false}
            placeholder="# Python"
          />
          {cell.outputs.length > 0 && (
            <div className="nb-output">
              {cell.outputs.map((out, i) => {
                if (out.kind === "text") return <pre key={i}>{out.text}</pre>;
                if (out.kind === "image") {
                  return (
                    <img
                      key={i}
                      src={`data:image/png;base64,${out.data}`}
                      alt="kernel output"
                    />
                  );
                }
                return (
                  <pre className="nb-error" key={i}>
                    {out.ename}: {out.evalue}
                    {"\n"}
                    {out.traceback.join("\n")}
                  </pre>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
