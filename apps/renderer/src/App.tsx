import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Notebook from "./Notebook";
import Permissions from "./Permissions";
import Settings from "./Settings";
import PermissionPill from "./PermissionPill";
import ModelPicker from "./ModelPicker";
import Sash from "./Sash";
import RightDock from "./RightDock";
import StatusBar from "./StatusBar";
import {
  UI_LIMITS,
  clampWidth,
  layoutPreset,
  loadUiState,
  saveUiState,
  type DockTab,
  type LayoutMode,
} from "./ui-state";
import ProviderSetupDialog from "./ProviderSetupDialog";
import ContextMeter from "./ContextMeter";
import Skills from "./Skills";
import Route from "./Route";
import ApprovalModal from "./ApprovalModal";
import FilePreview from "./FilePreview";
import Markdown from "./Markdown";
import ToolCard from "./ToolCard";
import ToolGroup from "./ToolGroup";
import { groupAdjacent, type ToolItem } from "./tool-summary";
import { copyText } from "./clipboard";
import { describeModelError, modelErrorLine, type ModelErrorInfo } from "./model-error";
import { applyMention, mentionInsert, mentionQueryParts, parseMention } from "./mention";
import { TABS_KEY, TABS_MAX, pruneTabs, pushTab, sanitizeTabs } from "./session-tabs";
import type {
  AgentMessage,
  AppError,
  ApprovalRequest,
  ApprovalScope,
  BridgeStatus,
  BudgetStatus,
  ContentBlock,
  PiEvent,
  ModelInfo,
  PiStreamItem,
  PolicyInfo,
  PolicyMode,
  SessionMetaEntry,
  SessionStats,
  SessionSummary,
  SessionTreeResult,
  SessionTreeNode,
  ForkResult,
  FileEntry,
  FileListResult,
  FileReadResult,
  FileStatResult,
  ImageAttachment,
  WorkspaceInfo,
} from "@oh-my-coding-pi/shared";

type Msg =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      args: string;
      done: boolean;
      result?: string;
      /** 起止时刻：用于一条、以及一组的耗时（缺一段就不算总数） */
      startedAt?: number;
      endedAt?: number;
      isError?: boolean;
      /** 被用户停下：不算失败 */
      interrupted?: boolean;
    }
  | { kind: "system"; text: string };

/** 会话分组：今天 / 昨天 / 更早（PR3） */
function sessionGroupOf(updatedAt: string | undefined): string {
  if (!updatedAt) return "更早";
  const then = new Date(updatedAt);
  if (Number.isNaN(then.getTime())) return "更早";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = then.getTime();
  if (t >= startOfToday) return "今天";
  if (t >= startOfToday - 86_400_000) return "昨天";
  return "更早";
}

function sessionFileKey(file: string): string {
  return file.split(/[/\\]/).pop() || file;
}

function readTabs(): string[] {
  try {
    return sanitizeTabs(JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]") as unknown);
  } catch {
    return [];
  }
}

const OVERLAY_TITLE = {
  permissions: "权限",
  skills: "技能",
  settings: "设置",
} as const;

const POLICY_LABEL: Record<PolicyMode, string> = {
  ask: "请求批准",
  allow: "完全访问",
  deny: "全拒",
  readonly: "只读",
  "deny-risky": "自动拦截",
  "ask-risky": "请求批准",
  "allow-all": "完全访问",
};

function ReadonlyBanner() {
  return (
    <div className="banner readonly">
      <span>
        <b>只读模式</b> 只允许 read / grep / find / ls；run_code 与写入会被拒绝。权限用于防误操作，不构成安全边界。
      </span>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function textOf(content: ContentBlock[] | string | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

function toMsgs(list: AgentMessage[]): Msg[] {
  const out: Msg[] = [];
  for (const m of list) {
    const text = textOf(m.content);
    if (m.role === "user" && text) out.push({ kind: "user", text });
    if (m.role === "assistant" && text) out.push({ kind: "assistant", text });
  }
  return out;
}

function TreeNodeView({
  node,
  leafId,
  onFork,
  depth,
}: {
  node: SessionTreeNode;
  leafId: string | null;
  onFork: (entryId: string) => void;
  depth: number;
}) {
  const entry = node.entry as { id: string; type: string; message?: AgentMessage };
  const msg = entry.message;
  const role = msg?.role ?? entry.type;
  const text = msg ? textOf(msg.content) : entry.type;
  const leaf = entry.id === leafId;
  return (
    <div className="tree-branch" style={{ paddingLeft: depth ? 12 : 0 }}>
      <button
        className={`tree-node ${leaf ? "leaf" : ""} ${msg?.role === "user" ? "forkable" : ""}`}
        onClick={() => {
          if (msg?.role === "user") onFork(entry.id);
        }}
        title={msg?.role === "user" ? "从此消息创建分支" : entry.type}
      >
        <span className="role">{role}</span>
        <span className="txt">{text.slice(0, 90) || entry.type}</span>
      </button>
      {node.children.map((child) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          leafId={leafId}
          onFork={onFork}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionMeta, setSessionMeta] = useState<Record<string, SessionMetaEntry>>({});
  const [metaIgnored, setMetaIgnored] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  /** Esc 取消时输入框卸载会触发 blur，用标记拦住那次误提交 */
  const renameCancelled = useRef(false);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [openTabs, setOpenTabs] = useState<string[]>(readTabs);
  /** 草稿和滚动位置只存内存：关掉应用就没了，不假装持久化。 */
  const draftsRef = useRef<Record<string, string>>({});
  const scrollRef = useRef<Record<string, number>>({});
  const pendingScroll = useRef<{ file: string; top: number } | null>(null);
  /** 用户按「停止」的时刻：用于把随后结束的工具记为「已停止」而不是失败 */
  const abortedAt = useRef<number | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<BridgeStatus>("starting");
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelKey, setModelKey] = useState("");
  /** 预检不通过时，就地打开「确认连接信息 + 存 key」对话框（PR2） */
  const [setupProvider, setSetupProvider] = useState<string | null>(null);
  const [tab, setTab] = useState<"sessions" | "tree">("sessions");
  const [tree, setTree] = useState<SessionTreeResult | null>(null);
  const [notice, setNotice] = useState("");
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [view, setView] = useState<"chat" | "route">("chat");
  const [overlay, setOverlay] = useState<"permissions" | "skills" | "settings" | null>(null);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return localStorage.getItem("omcp.theme") === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  /** 右坞开/关不落盘：它是这个窗口此刻的样子，不是设置（借自 DAWN state/dock.ts） */
  const [dockOpen, setDockOpen] = useState(true);
  const [ui, setUi] = useState(loadUiState);
  const [sessionQuery, setSessionQuery] = useState("");
  const [filePath, setFilePath] = useState("");
  const [fileList, setFileList] = useState<FileListResult | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileInfo, setFileInfo] = useState<FileStatResult | null>(null);
  const [preview, setPreview] = useState<FileReadResult | null>(null);
  const [modelError, setModelError] = useState<ModelErrorInfo | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  /** `@` 补全：start 是 `@` 的下标，query 是 `@` 后面已经敲的部分 */
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionEntries, setMentionEntries] = useState<FileEntry[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelSelectRef = useRef<HTMLButtonElement>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; data: string; mimeType: string }>
  >([]);
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const pendingText = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.api.getSessions());
    } catch {
      setSessions([]);
    }
    try {
      const meta = await window.api.getSessionMeta();
      setSessionMeta(meta.sessions ?? {});
      setMetaIgnored(meta.ignored === true);
    } catch {
      setSessionMeta({});
      setMetaIgnored(false);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await window.api.getAvailableModels());
    } catch {
      // pi 未就绪时保留旧列表
    }
  }, []);

  const appendAssistantText = useCallback((chunk: string) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const cur = next[i];
        if (cur.kind === "assistant") {
          next[i] = { kind: "assistant", text: cur.text + chunk };
          return next;
        }
      }
      return [...next, { kind: "assistant", text: chunk }];
    });
  }, []);

  /** 丢字时不渲染：message_end 会给出完整文本 */
  const discardPendingText = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    pendingText.current = "";
  }, []);

  /** 流式文本 40 ms 一批，不是每个 delta 都重渲染 */
  const queueAssistantText = useCallback(
    (chunk: string) => {
      pendingText.current += chunk;
      if (flushTimer.current) return;
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const text = pendingText.current;
        pendingText.current = "";
        if (text) appendAssistantText(text);
      }, 40);
    },
    [appendAssistantText],
  );

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.api.getStats());
    } catch {
      // ignore
    }
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const state = await window.api.getState();
      setCurrentFile(state.sessionFile ?? null);
      // pi 在没有模型时会报一个 unknown/unknown 占位，不要把它当成"已选模型"
      const m = state.model;
      const usable = m && m.provider && m.id && m.provider !== "unknown" && m.id !== "unknown";
      setModelKey(usable ? `${m.provider}/${m.id}` : "");
    } catch {
      // ignore
    }
  }, []);

  const refreshWorkspace = useCallback(async () => {
    try {
      setWorkspace(await window.api.getWorkspace());
    } catch {
      // ignore
    }
  }, []);

  const refreshBudget = useCallback(async () => {
    try {
      setBudget(await window.api.getBudget());
    } catch {
      // ignore
    }
  }, []);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await window.api.getTree());
    } catch {
      setTree(null);
    }
  }, []);

  const refreshSession = useCallback(async () => {
    // 切会话前把未落屏的 delta 丢掉，否则它会拼到新会话的最后一条回复上
    discardPendingText();
    try {
      const list = await window.api.getMessages();
      setMessages(toMsgs(list));
    } catch {
      setMessages([]);
    }
    await refreshState();
    await refreshStats();
    await refreshTree();
  }, [refreshState, refreshStats, refreshTree, discardPendingText]);

  useEffect(() => {
    window.api.signalReady();
    void refreshSessions();
    void refreshSession();
    void refreshWorkspace();
    void refreshModels();
    void refreshBudget();
    window.api
      .getPolicy()
      .then((info) => setPolicy(info as PolicyInfo | null))
      .catch(() => setPolicy(null));

    const offEvent = window.api.onEvent((raw: PiStreamItem) => {
      if (raw.type === "response") return;
      const ev = raw as PiEvent;

      switch (ev.type) {
        case "agent_start":
          setBusy(true);
          return;
        case "agent_settled":
          setBusy(false);
          void refreshStats();
          void refreshState();
          void refreshSessions();
          void refreshTree();
          void refreshBudget();
          return;
        case "message_start":
          if (ev.message.role === "assistant") {
            discardPendingText();
            setMessages((prev) => [...prev, { kind: "assistant", text: "" }]);
          }
          return;
        case "message_update": {
          const delta = ev.assistantMessageEvent;
          if (delta.type !== "text_delta" || !delta.delta) return;
          queueAssistantText(delta.delta);
          return;
        }
        case "message_end": {
          if (ev.message.role !== "assistant") return;
          discardPendingText();
          const errRaw = ev.message.errorMessage?.trim();
          if (errRaw || ev.message.stopReason === "error") {
            const info = describeModelError(errRaw || "模型没有返回内容（stopReason=error）");
            if (info) {
              setModelError(info);
              setMessages((prev) => [...prev, { kind: "system", text: modelErrorLine(info) }]);
            }
          }
          const text = textOf(ev.message.content);
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const cur = next[i];
              if (cur.kind === "assistant") {
                if (text) next[i] = { kind: "assistant", text };
                else if (!cur.text) next.splice(i, 1);
                return next;
              }
            }
            return prev;
          });
          return;
        }
        case "tool_execution_start":
          setMessages((prev) => [
            ...prev,
            {
              kind: "tool",
              id: ev.toolCallId,
              name: ev.toolName,
              args: JSON.stringify(ev.args),
              done: false,
              startedAt: Date.now(),
            },
          ]);
          return;
        case "tool_execution_end":
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const cur = next[i];
              if (cur.kind === "tool" && cur.id === ev.toolCallId) {
                const endedAt = Date.now();
                // 用户在本条开始之后按过停止 → 记为「已停止」，不计入失败
                const interrupted = abortedAt.current !== null && abortedAt.current >= (cur.startedAt ?? 0);
                next[i] = {
                  ...cur,
                  done: true,
                  endedAt,
                  isError: Boolean(ev.isError) && !interrupted,
                  ...(interrupted ? { interrupted: true } : {}),
                  result: textOf(ev.result.content).slice(0, 600),
                };
                return next;
              }
            }
            return prev;
          });
          return;
        case "extension_error":
          setMessages((prev) => [...prev, { kind: "system", text: ev.message }]);
          return;
        default:
          return;
      }
    });

    const offStatus = window.api.onStatus((s) => {
      setStatus(s);
      // pi 重启完成后模型列表可能变了（例如刚加了 provider）
      if (s === "ready") void refreshModels();
    });
    const offError = window.api.onError((e) => setAppError(e));
    const offWorkspace = window.api.onWorkspace((info) => {
      setWorkspace(info);
      void refreshSession();
      void refreshSessions();
      void refreshTree();
      void refreshBudget();
    });
    const offPolicy = window.api.onPolicyChanged((info) => setPolicy(info as PolicyInfo));
    const offApproval = window.api.onApproval((req) => setApproval(req as ApprovalRequest));
    const offApprovalResolved = window.api.onApprovalResolved((info) => {
      setApproval((cur) => (cur && cur.id === info.requestId ? null : cur));
    });
    setStatus("ready");
    return () => {
      offEvent();
      offStatus();
      offError();
      offWorkspace();
      offApproval();
      offApprovalResolved();
      offPolicy();
    };
  }, [refreshSessions, refreshSession, refreshStats, refreshState, refreshTree, refreshBudget, refreshWorkspace, queueAssistantText, discardPendingText]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("omcp.theme", theme);
    } catch {
      // 写不进去就只影响下次启动的默认值
    }
  }, [theme]);

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOverlay(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlay]);

  useEffect(() => {
    const onChange = () => void refreshModels();
    window.addEventListener("omcp:models-changed", onChange);
    return () => window.removeEventListener("omcp:models-changed", onChange);
  }, [refreshModels]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 页签只收当前工作区里真实存在的会话文件，否则换工作区后旧路径会残留
  useEffect(() => {
    if (!sessions.length) return;
    const valid = new Set(sessions.map((s) => s.sessionFile));
    setOpenTabs((prev) => pruneTabs(prev, valid, currentFile));
  }, [sessions, currentFile]);

  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(openTabs));
    } catch {
      // 隐私模式下写不进去，页签仍可用
    }
  }, [openTabs]);

  const loadDir = useCallback(async (path: string) => {
    setFileLoading(true);
    setFileInfo(null);
    setPreview(null);
    try {
      const res = await window.api.listFiles(path);
      setFileList(res);
      if (!res.error) setFilePath(res.path);
    } catch {
      setFileList({ path, entries: [], truncated: false, error: "读取失败" });
    } finally {
      setFileLoading(false);
    }
  }, []);

  // 打开右坞文件页、或换工作区时，回到根目录重新列
  useEffect(() => {
    if (!dockOpen || ui.dockTab !== "files" || !workspace?.root) return;
    setFilePath("");
    setFileInfo(null);
    setPreview(null);
    void loadDir("");
  }, [dockOpen, ui.dockTab, workspace?.root, loadDir]);

  async function selectFile(path: string) {
    setPreviewLoading(true);
    const [info, content] = await Promise.all([
      window.api.statFile(path).catch(() => null),
      window.api.readFile(path).catch(() => null),
    ]);
    setFileInfo(info ?? null);
    setPreview(
      content ?? { path, kind: "binary", size: 0, error: "读取失败" },
    );
    setPreviewLoading(false);
  }

  /** 只看光标前的内容：`@` 后面可以带目录，比如 `data/pro` */
  function updateMention(value: string, caret: number) {
    setMention(parseMention(value, caret));
  }

  // 补全只查一层：query 里的目录部分走 fs:list，文件部分做前缀匹配
  useEffect(() => {
    if (!mention) {
      setMentionEntries([]);
      return;
    }
    let cancelled = false;
    const { dir, prefix } = mentionQueryParts(mention.query);
    const timer = setTimeout(() => {
      void window.api
        .listFiles(dir)
        .catch(() => null)
        .then((res) => {
          if (cancelled) return;
          if (!res || res.error) {
            setMentionEntries([]);
            return;
          }
          setMentionEntries(
            res.entries.filter((e) => e.name.toLowerCase().startsWith(prefix)).slice(0, 20),
          );
          setMentionIndex(0);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention]);

  function acceptMention(entry: FileEntry) {
    if (!mention) return;
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const insert = mentionInsert(entry);
    const applied = applyMention(input, caret, mention, insert);
    setInput(applied.value);
    setMention(null);
    setMentionEntries([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(applied.caret, applied.caret);
    });
  }

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const pending = pendingScroll.current;
    if (pending && pending.file === currentFile) {
      el.scrollTop = pending.top;
      pendingScroll.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, currentFile]);

  async function send(mode: "prompt" | "steer" | "followUp") {
    const text = input.trim();
    if (!text) return;
    if (!modelKey) {
      // 默认不预置模型：先让用户选，避免发出去只拿到一个底层报错
      setNotice(
        models.length === 0
          ? "还没有可用模型：到设置里添加 provider，或在右上角选择"
          : "还没有选择模型：右上角选一个再发送",
      );
      if (models.length === 0) setOverlay("settings");
      else modelSelectRef.current?.focus();
      return;
    }
    // 发送前预检：缺凭据 / 地址不对 / 模型不存在就别发，直接告诉用户怎么修
    const [provider, ...modelParts] = modelKey.split("/");
    const modelId = modelParts.join("/");
    try {
      const pf = (await window.api.modelPreflight(provider, modelId)) as {
        ok: boolean;
        reason: string;
        message: string;
        fix?: string;
      };
      if (!pf.ok) {
        setModelError(describeModelError(pf.message) ?? { kind: "unknown", title: pf.message, detail: "" });
        if (pf.fix === "add_key" || pf.fix === "confirm_connection") {
          setNotice(pf.message + "：已打开连接设置");
          setSetupProvider(provider);
        } else {
          setNotice(pf.message);
          modelSelectRef.current?.focus();
        }
        return;
      }
    } catch {
      // 预检自身失败不阻断发送：pi 那边还有一道真实校验
    }

    setModelError(null);
    setMessages((prev) => [...prev, { kind: "user", text }]);
    setInput("");
    setMention(null);
    setMentionEntries([]);
    // 发出去就不再算草稿，否则切走再切回来会把已发送的文字又填回输入框
    if (currentFile) draftsRef.current[currentFile] = "";
    setAttachments([]);
    try {
      const res =
        mode === "steer"
          ? await window.api.steer(text)
          : mode === "followUp"
            ? await window.api.followUp(text)
            : await window.api.prompt(
                text,
                attachments.length
                  ? attachments.map((a): ImageAttachment => ({
                      type: "image",
                      data: a.data,
                      mimeType: a.mimeType,
                    }))
                  : undefined,
              );
      if (!res.ok) {
        // pi 的拒绝原因要原样给出来（例如缺密钥、未知 provider），
        // 只说“消息未被接受”等于把唯一有用的信息丢掉。
        const detail = res.error ?? "pi 未说明原因";
        const hint = /no api key/i.test(detail)
          ? "\n提示：去「设置 → 模型注册表」给这个 provider 保存密钥；改完密钥会自动重启 pi。"
          : /unknown provider|model not found/i.test(detail)
            ? "\n提示：pi 不认识这个 provider/模型，去「设置 → 模型注册表」确认已保存并同步到 models.json。"
            : "";
        setMessages((prev) => [...prev, { kind: "system", text: `消息未被接受：${detail}${hint}` }]);
      }
    } catch {
      setMessages((prev) => [...prev, { kind: "system", text: "发送失败，请检查 pi 状态" }]);
    }
  }

  async function changeModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    // 只有 pi 真的接受了才更新界面：没配 key 或模型不存在时不能显示成换过了
    const res = await window.api.setModel(provider, modelId).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (res.ok) {
      await refreshState();
      return { ok: true };
    }
    setModelError(describeModelError(res.error ?? "切换模型失败"));
    return { ok: false, error: res.error ?? "切换模型失败" };
  }

  async function abort() {
    abortedAt.current = Date.now();
    setBusy(false);
    setStatus("ready");
    await window.api.abort().catch(() => undefined);
  }

  async function loadSession(file: string) {
    if (busy || file === currentFile) return;
    if (currentFile) {
      draftsRef.current[currentFile] = input;
      scrollRef.current[currentFile] = listRef.current?.scrollTop ?? 0;
    }
    const ok = await window.api.switchSession(file).catch(() => false);
    if (ok) {
      ensureTab(file);
      // 只在有存过的位置时接管滚动，否则让它滚到底
      if (file in scrollRef.current) pendingScroll.current = { file, top: scrollRef.current[file] };
      await refreshSession();
      await refreshSessions();
      setInput(draftsRef.current[file] ?? "");
    }
  }

  function ensureTab(file: string) {
    // 超上限时 pushTab 会丢最早的页签（只影响页签，不动会话文件）——告知一声
    if (!openTabs.includes(file) && openTabs.length >= TABS_MAX) {
      setNotice(`页签最多 ${TABS_MAX} 个，已收起最早的一个；会话文件未删除，可从列表重新打开。`);
    }
    setOpenTabs((prev) => pushTab(prev, file));
  }

  async function closeTab(file: string) {
    const idx = openTabs.indexOf(file);
    if (idx < 0) return;
    const rest = openTabs.filter((f) => f !== file);
    if (rest.length === 0) return; // 至少留一个页签
    if (file === currentFile) {
      if (busy) return; // 忙时切不了，先不关
      await loadSession(rest[Math.min(idx, rest.length - 1)]);
    }
    setOpenTabs(rest);
  }

  function tabLabel(file: string): string {
    const entry = sessionMeta[sessionFileKey(file)];
    if (entry?.title) return entry.title;
    const summary = sessions.find((s) => s.sessionFile === file);
    if (summary) return summary.sessionId.slice(0, 8);
    return sessionFileKey(file).replace(/\.jsonl$/i, "").slice(0, 8);
  }

  async function commitRename(file: string) {
    if (renameCancelled.current) {
      renameCancelled.current = false;
      return;
    }
    if (renamingFile !== file) return;
    setRenamingFile(null);
    const res = await window.api.setSessionMeta(file, { title: renameValue }).catch(() => ({ ok: false, error: "重命名失败" }));
    if (!res.ok) setNotice(res.error || "重命名失败");
    await refreshSessions();
  }

  async function toggleArchive(file: string, archived: boolean) {
    const res = await window.api.setSessionMeta(file, { archived }).catch(() => ({ ok: false, error: "归档失败" }));
    if (!res.ok) setNotice(res.error || "归档失败");
    await refreshSessions();
  }

  async function newSession() {
    if (busy) return;
    const ok = await window.api.newSession().catch(() => false);
    if (ok) {
      discardPendingText();
      setMessages([]);
      setStats(null);
      setCurrentFile(null);
      await refreshSessions();
    }
  }

  async function cloneCurrent() {
    if (busy) return;
    const r = await window.api.clone().catch(() => ({ cancelled: true }));
    if (!r.cancelled) {
      await refreshSession();
      await refreshSessions();
      setNotice("已克隆当前分支");
    }
  }

  async function forkFrom(entryId: string) {
    if (busy) return;
    if (!confirm("从这条消息创建分支？当前会话会切换到这个分支。")) return;
    const r: ForkResult = await window.api.fork(entryId).catch(() => ({ cancelled: true }));
    if (r.cancelled) {
      setNotice("分支创建被取消");
      return;
    }
    await refreshSession();
    await refreshSessions();
    setNotice(r.persisted === false ? "分支已创建，文件尚未落盘；发一条消息后会写入" : "已创建分支");
  }

  async function exportHtml() {
    const path = await window.api.exportHtml().catch(() => null);
    setNotice(path ? "已导出：" + path : "导出失败");
  }

  async function restartPi() {
    await window.api.restart().catch(() => undefined);
    setNotice("正在重启 pi…");
  }

  async function pickWorkspace() {
    const result = await window.api.pickWorkspace().catch(() => null);
    if (!result) return;
    await refreshWorkspace();
    await refreshSession();
    await refreshSessions();
    await refreshTree();
    await refreshBudget();
  }

  async function openWorkspacePath(root: string) {
    if (!root) return;
    try {
      await window.api.openWorkspace(root);
      await refreshWorkspace();
      await refreshSession();
      await refreshSessions();
      await refreshTree();
      await refreshBudget();
    } catch {
      setNotice("工作区打开失败");
    }
  }

  const modelSupportsImage = (() => {
    if (!modelKey) return true;
    const found = models.find((m) => `${m.provider}/${m.id}` === modelKey);
    if (!found) return true;
    return Boolean(found.input?.includes("image"));
  })();

  const addImageFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    const next: Array<{ id: string; data: string; mimeType: string }> = [];
    for (const file of images.slice(0, 4)) {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      next.push({
        id: `${file.name}-${Date.now()}-${next.length}`,
        data: btoa(binary),
        mimeType: file.type || "image/png",
      });
    }
    setAttachments((cur) => [...cur, ...next].slice(0, 4));
  }, []);

  const respondApproval = useCallback(
    (scope: ApprovalScope) => {
      const current = approval;
      if (!current) return;
      setApproval(null);
      void window.api.respondApproval({
        requestId: current.id,
        scope,
        decidedAt: new Date().toISOString(),
      });
    },
    [approval],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionEntries.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionEntries.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionEntries.length) % mentionEntries.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptMention(mentionEntries[mentionIndex] ?? mentionEntries[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        setMentionEntries([]);
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (!input.trim()) return;
    void send(busy ? "steer" : "prompt");
  }

  const setDockTab = (tab: DockTab) => {
    setUi((cur) => (cur.dockTab === tab ? cur : { ...cur, dockTab: tab }));
    saveUiState({ dockTab: tab });
  };

  const toggleDock = () => setDockOpen((open) => !open);

  /** 会话列表的可见集合：搜索 + 归档过滤 + 按更新时间倒序（PR3） */
  const visibleSessions = sessions
    .filter((s) => showArchived || !sessionMeta[sessionFileKey(s.sessionFile)]?.archived || s.sessionFile === currentFile)
    .filter((s) => {
      const q = sessionQuery.trim().toLowerCase();
      if (!q) return true;
      const title = sessionMeta[sessionFileKey(s.sessionFile)]?.title ?? "";
      return `${title} ${s.sessionId} ${s.sessionFile}`.toLowerCase().includes(q);
    })
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));

  const toggleSidebar = () => {
    setUi((cur) => {
      const next = { ...cur, sidebarCollapsed: !cur.sidebarCollapsed };
      saveUiState({ sidebarCollapsed: next.sidebarCollapsed });
      return next;
    });
  };

  const applyLayout = (mode: LayoutMode) => {
    const preset = layoutPreset(mode);
    setDockOpen(preset.dockOpen);
    setUi((cur) => {
      const next: typeof cur = {
        ...cur,
        layout: mode,
        sidebarWidth: preset.sidebarWidth,
        dockWidth: preset.dockWidth,
        sidebarCollapsed: preset.collapsed,
      };
      saveUiState({
        layout: mode,
        sidebarWidth: next.sidebarWidth,
        dockWidth: next.dockWidth,
        sidebarCollapsed: next.sidebarCollapsed,
      });
      return next;
    });
  };

  /** 快捷键：Ctrl+B 左栏 / Ctrl+J 右坞 / Ctrl+1..4 布局 / Ctrl+Alt+1..4 右坞面板 */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        toggleDock();
      }
    };
    const onAlt = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || !e.altKey) return;
      const idx = Number(e.key);
      if (!Number.isInteger(idx) || idx < 1 || idx > 4) return;
      e.preventDefault();
      const tab: DockTab = (["files", "notebook", "artifacts", "run"] as DockTab[])[idx - 1]!;
      setDockTab(tab);
    };
    const onPlain = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const idx = Number(e.key);
      if (!Number.isInteger(idx) || idx < 1 || idx > 4) return;
      e.preventDefault();
      applyLayout((["chat", "analysis", "focus", "notebook"] as LayoutMode[])[idx - 1]!);
    };
    window.addEventListener("keydown", onAlt);
    window.addEventListener("keydown", onPlain);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onAlt);
      window.removeEventListener("keydown", onPlain);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className={`shell${dockOpen ? " dock-open" : ""}${ui.sidebarCollapsed ? " side-collapsed" : ""}`}
      style={{
        ["--side-w" as string]: `${ui.sidebarWidth}px`,
        ["--dock-w" as string]: `${ui.dockWidth}px`,
      }}
    >
      <aside className="sidebar">
        <div className="side-head">
          <strong>oh my coding pi</strong>
          <span className="tag">P2</span>
        </div>
        <div className="workspace">
          <div className="ws-name" title={workspace?.root}>
            {workspace ? workspace.root.split(/[\/]/).filter(Boolean).pop() : "…"}
          </div>
          <div className="ws-path" title={workspace?.root ?? ""}>
            {workspace?.root ?? "未打开工作区"}
          </div>
          <div className="ws-meta">
            <span className="pill">{sessions.length} 会话</span>
            <span className="pill">{(workspace?.recent ?? []).length} 最近</span>
          </div>
          <div className="ws-actions">
            <select value="" onChange={(e) => openWorkspacePath(e.target.value)}>
              <option value="">最近工作区</option>
              {(workspace?.recent ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button onClick={pickWorkspace}>切换</button>
          </div>
        </div>
        <div className="side-tabs">
          <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>
            会话
          </button>
          <button className={tab === "tree" ? "active" : ""} onClick={() => setTab("tree")}>
            树
          </button>
        </div>
        <div className="side-actions">
          <button onClick={newSession} disabled={busy}>
            新建
          </button>
          <button onClick={cloneCurrent} disabled={busy}>
            克隆
          </button>
          <button onClick={exportHtml}>导出</button>
          <button className={showArchived ? "active" : ""} onClick={() => setShowArchived((v) => !v)} title="显示或隐藏已归档会话">
            归档
          </button>
        </div>
        {tab === "sessions" ? (
          <div className="session-list">
            <input
              className="side-search"
              value={sessionQuery}
              placeholder="搜索会话…"
              spellCheck={false}
              onChange={(e) => setSessionQuery(e.target.value)}
              aria-label="搜索会话"
            />
            {sessions.length === 0 && <div className="side-empty">还没有会话</div>}
            {metaIgnored && (
              <div className="side-empty">标题文件损坏，已忽略。会话列表不受影响。</div>
            )}
            {visibleSessions.length === 0 && sessions.length > 0 && (
              <div className="side-empty">{sessionQuery.trim() ? "没有匹配的会话" : "没有未归档会话"}</div>
            )}
            {visibleSessions
              .map((s, index) => {
                const group = sessionGroupOf(s.updatedAt);
                const prev = index > 0 ? sessionGroupOf(visibleSessions[index - 1]!.updatedAt) : null;
                const key = sessionFileKey(s.sessionFile);
                const entry = sessionMeta[key];
                const label = entry?.title || s.sessionId.slice(0, 8);
                return (
                  <Fragment key={s.sessionFile}>
                  {group !== prev && <div className="side-group">{group}</div>}
                  <div
                    className={`session ${s.sessionFile === currentFile ? "active" : ""} ${entry?.archived ? "archived" : ""}`}
                  >
                    {renamingFile === s.sessionFile ? (
                      <input
                        className="session-rename"
                        value={renameValue}
                        autoFocus
                        maxLength={80}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(s.sessionFile);
                          if (e.key === "Escape") {
                            renameCancelled.current = true;
                            setRenamingFile(null);
                          }
                        }}
                        onBlur={() => void commitRename(s.sessionFile)}
                      />
                    ) : (
                      <button
                        className="session-open"
                        onClick={() => loadSession(s.sessionFile)}
                        title={entry?.title ? `${entry.title}\n${s.sessionFile}` : s.sessionFile}
                      >
                        <span className="sid">{label}</span>
                        <span className="stamp">
                          {entry?.archived ? "归档 · " : ""}
                          {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}
                        </span>
                      </button>
                    )}
                    <span className="session-tools">
                      <button
                        type="button"
                        className="mini"
                        onClick={() => {
                          renameCancelled.current = false;
                          setRenamingFile(s.sessionFile);
                          setRenameValue(entry?.title || "");
                        }}
                      >
                        重命名
                      </button>
                      <button type="button" className="mini" onClick={() => void toggleArchive(s.sessionFile, !entry?.archived)}>
                        {entry?.archived ? "还原" : "归档"}
                      </button>
                    </span>
                  </div>
                  </Fragment>
                );
              })}
          </div>
        ) : (
          <div className="tree-panel">
            {tree && tree.tree.length > 0 ? (
              tree.tree.map((node) => (
                <TreeNodeView
                  key={node.entry.id}
                  node={node}
                  leafId={tree.leafId}
                  onFork={forkFrom}
                  depth={0}
                />
              ))
            ) : (
              <div className="side-empty">暂无树</div>
            )}
          </div>
        )}
        <div className="side-foot">
          <button onClick={() => setOverlay("permissions")}>权限</button>
          <button onClick={() => setOverlay("skills")}>技能</button>
          <button onClick={() => setOverlay("settings")}>设置</button>
        </div>
      </aside>

      {!ui.sidebarCollapsed && (
        <Sash
          side="left"
          width={ui.sidebarWidth}
          min={UI_LIMITS.sidebar.min}
          max={UI_LIMITS.sidebar.max}
          label="调整侧栏宽度"
          onChange={(next) => setUi((cur) => ({ ...cur, sidebarWidth: clampWidth("sidebar", next) }))}
          onCommit={(next) => saveUiState({ sidebarWidth: clampWidth("sidebar", next) })}
        />
      )}

      <div className="main">
        <div className="top">
        <header className="bar">
          {/* 左栏收起时才在顶栏补品牌，避免同一个名字出现两次 */}
          {ui.sidebarCollapsed && (
            <div className="brand">
              <strong>oh my coding pi</strong>
              <span className="tag">P2</span>
            </div>
          )}
          <div className="bar-right">
            <PermissionPill />
            <ContextMeter sessionKey={currentFile} busy={busy} />
            <ModelPicker
              models={models}
              value={modelKey}
              disabled={busy}
              onPick={changeModel}
              triggerRef={modelSelectRef}
            />
            <button
              className="dock-toggle"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title="切换深色 / 亮色"
            >
              {theme === "dark" ? "亮色" : "深色"}
            </button>
            <select
              className="layout-select"
              value={ui.layout}
              onChange={(e) => applyLayout(e.target.value as LayoutMode)}
              title="布局：Ctrl+1 对话 / Ctrl+2 分析 / Ctrl+3 专注 / Ctrl+4 笔记本"
              aria-label="布局模式"
            >
              <option value="chat">对话为主</option>
              <option value="analysis">分析为主</option>
              <option value="focus">专注</option>
              <option value="notebook">笔记本优先</option>
            </select>
            <button
              className="dock-toggle"
              onClick={toggleSidebar}
              aria-pressed={!ui.sidebarCollapsed}
              title="显示或收起左栏（Ctrl+B）"
            >
              {ui.sidebarCollapsed ? "左栏" : "收起左栏"}
            </button>
            <button
              className="dock-toggle"
              onClick={toggleDock}
              aria-pressed={dockOpen}
              title="显示或收起右侧工作坞（Ctrl+J）"
            >
              {dockOpen ? "收起右坞" : "右坞"}
            </button>
            <span className={`status ${status}`}>{status}</span>
            {busy && (
              <button className="abort" onClick={abort}>
                停止
              </button>
            )}
          </div>
        </header>
        {openTabs.length > 0 && (
          <div className="session-tabs" role="tablist" aria-label="已打开的会话">
            {openTabs.map((file) => {
              const active = file === currentFile;
              const label = tabLabel(file);
              return (
                <div key={file} className={`session-tab ${active ? "active" : ""}`}>
                  <button
                    type="button"
                    className="tab-label"
                    role="tab"
                    aria-selected={active}
                    disabled={busy && !active}
                    title={busy && !active ? "正在运行，先停止再切换" : file}
                    onClick={() => void loadSession(file)}
                  >
                    {label}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`关闭页签 ${label}`}
                    disabled={openTabs.length === 1 || (active && busy)}
                    title={openTabs.length === 1 ? "至少保留一个页签" : "关闭页签，不删除会话文件"}
                    onClick={() => void closeTab(file)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="viewtabs">
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            对话
          </button>
          <button className={view === "route" ? "active" : ""} onClick={() => setView("route")}>
            路线
          </button>
        </div>
        {(status === "restarting" || status === "error") && (
          <div className="banner warn">
            <span>pi 已断开，正在恢复当前会话…</span>
            <button onClick={restartPi}>立即重启</button>
          </div>
        )}
        {modelError && (
          <div className="banner fatal">
            <span title={`${modelError.title}：${modelError.detail}`}>
              <b>{modelError.title}</b>{" "}
              {modelError.detail.length > 110
                ? modelError.detail.slice(0, 110) + "…"
                : modelError.detail}
              {modelError.hint ? `（${modelError.hint}）` : ""}
            </span>
            <button
              onClick={() => {
                modelSelectRef.current?.focus();
                setNotice("在上方模型选择器里换一个模型");
              }}
            >
              换个模型
            </button>
            <button onClick={() => setModelError(null)}>关闭</button>
          </div>
        )}
        {policy?.mode === "readonly" && <ReadonlyBanner />}
        {notice && <div className="notice">{notice}</div>}
        {appError && (
          <div className={`banner ${appError.severity === "warning" ? "warn" : "fatal"}`}>
            <span>
              <b>{appError.title}</b> {appError.detail}
            </span>
            {appError.action === "restart-pi" && <button onClick={restartPi}>重启</button>}
            <button onClick={() => setAppError(null)}>关闭</button>
          </div>
        )}
        </div>

        <main className="list" ref={listRef}>
          {view === "chat" ? (
            <>
          {messages.length === 0 && (
            !modelKey ? (
              <div className="empty">
                <div>还没有配置模型</div>
                <div className="empty-sub">
                  装好之后不预置任何模型。到设置里添加 provider 与 key，或在已有 provider 里选一个。
                </div>
                <button className="empty-btn" onClick={() => setOverlay("settings")}>
                  打开设置
                </button>
              </div>
            ) : (
              <div className="empty">输入一句话开始。Enter 发送，Shift+Enter 换行。</div>
            )
          )}
          {groupAdjacent(
            messages,
            (m) => m.kind === "tool",
            (m) => (m.kind === "tool" ? m.id : String(m.kind)),
          ).map((block) => {
            if (block.kind === "group") {
              return <ToolGroup key={block.key} tools={block.items as ToolItem[]} />;
            }
            const m = block.item;
            const i = block.index;
            if (m.kind === "user") {
              return (
                <div className="msg user" key={i}>
                  <div className="who">你</div>
                  <div className="bubble">{m.text}</div>
                </div>
              );
            }
            if (m.kind === "assistant") {
              return (
                <div className="msg assistant" key={i}>
                  <div className="who-row">
                    <span className="who">pi</span>
                    <button className="mini" onClick={() => copyText(m.text)}>
                      复制
                    </button>
                  </div>
                  <div className="bubble">
                    <Markdown text={m.text} />
                  </div>
                </div>
              );
            }
            if (m.kind === "tool") {
              return (
                <ToolCard
                  key={i}
                  name={m.name}
                  args={m.args}
                  done={m.done}
                  result={m.result}
                  {...(m.startedAt !== undefined ? { startedAt: m.startedAt } : {})}
                  {...(m.endedAt !== undefined ? { endedAt: m.endedAt } : {})}
                  {...(m.isError ? { isError: true } : {})}
                  {...(m.interrupted ? { interrupted: true } : {})}
                />
              );
            }
            return (
              <div className="msg system" key={i}>
                {m.text}
              </div>
            );
          })}
            </>
          ) : (
            <Route />
          )}
        </main>

        {view === "chat" && (
        <footer className="composer">
          <div className="cost">
            {stats ? (
              <>
                <span>${stats.cost.toFixed(6)}</span>
                <span>
                  {stats.contextUsage
                    ? `${Math.round(stats.contextUsage.percent ?? 0)}% ctx`
                    : "ctx —"}
                </span>
                <span>{stats.tokens.input + stats.tokens.output} tok</span>
                <span>
                  {stats.userMessages}U / {stats.assistantMessages}A
                </span>
                {budget && (
                  <span>
                    session ${budget.sessionUsd.toFixed(4)}/${budget.sessionLimit} · day $
                    {budget.dailyUsd.toFixed(4)}/{budget.dailyLimit}
                  </span>
                )}
              </>
            ) : (
              <span>cost —</span>
            )}
            {policy && (
              <button
                type="button"
                className={`policy-pill ${policy.mode}`}
                title={`权限模式：${policy.mode}（点击打开权限浮层）`}
                onClick={() => setOverlay("permissions")}
              >
                {POLICY_LABEL[policy.mode]}
              </button>
            )}
          </div>
          {attachments.length > 0 && (
            <div className="attach-row">
              {attachments.map((a) => (
                <span className="attach" key={a.id}>
                  <img src={`data:${a.mimeType};base64,${a.data}`} alt="附件" />
                  <button
                    title="移除"
                    onClick={() => setAttachments((cur) => cur.filter((x) => x.id !== a.id))}
                  >
                    ×
                  </button>
                </span>
              ))}
              {!modelSupportsImage && (
                <span className="attach-hint">当前模型仅文本：图片会先转述再发送</span>
              )}
            </div>
          )}
          <div className="composer-input">
            <textarea
              ref={textareaRef}
              value={input}
              placeholder={
                busy ? "pi 正在工作；Enter 插入，Shift+Enter 换行" : "输入消息，Enter 发送；可粘贴图片，@ 补全路径"
              }
              onChange={(e) => {
                const value = e.target.value;
                setInput(value);
                updateMention(value, e.target.selectionStart ?? value.length);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => setMention(null)}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files ?? []);
                if (files.some((f) => f.type.startsWith("image/"))) {
                  e.preventDefault();
                  void addImageFiles(files);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                void addImageFiles(Array.from(e.dataTransfer.files ?? []));
              }}
              onDragOver={(e) => e.preventDefault()}
            />
            {mention && mentionEntries.length > 0 && (
              <ul className="mention-list" role="listbox" aria-label="工作区路径补全">
                {mentionEntries.map((entry, i) => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={i === mentionIndex ? "active" : ""}
                      onMouseDown={(ev) => {
                        ev.preventDefault();
                        acceptMention(entry);
                      }}
                    >
                      <span className="mention-name">
                        {entry.type === "dir" ? "▸ " : ""}
                        {entry.name}
                        {entry.type === "dir" ? "/" : ""}
                      </span>
                      <span className="mention-path">
                        {entry.path === entry.name ? "" : entry.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {busy ? (
            <div className="send-group">
              <button onClick={() => send("steer")} disabled={!input.trim()}>
                插入
              </button>
              <button className="secondary" onClick={() => send("followUp")} disabled={!input.trim()}>
                追加
              </button>
            </div>
          ) : (
            <button onClick={() => send("prompt")} disabled={!input.trim()}>
              发送
            </button>
          )}
        </footer>
        )}
        <StatusBar
          status={status}
          modelKey={modelKey}
          cost={stats?.cost}
          contextPercent={stats?.contextUsage?.percent ?? undefined}
          policyMode={policy?.mode}
        />
      </div>
      {/* 右坞始终挂载：笔记本只允许存在一份，收起或切页时用 CSS 藏，不卸载 */}
      {dockOpen && (
        <Sash
          side="right"
          width={ui.dockWidth}
          min={UI_LIMITS.dock.min}
          max={UI_LIMITS.dock.max}
          label="调整右坞宽度"
          onChange={(next) => setUi((cur) => ({ ...cur, dockWidth: clampWidth("dock", next) }))}
          onCommit={(next) => saveUiState({ dockWidth: clampWidth("dock", next) })}
        />
      )}
      <RightDock
        open={dockOpen}
        tab={ui.dockTab}
        onTab={setDockTab}
        files={(

              <div className="dock-files">
                <div className="dock-crumbs">
                  <button onClick={() => void loadDir("")} title="工作区根目录">
                    根
                  </button>
                  {filePath.split("/").filter(Boolean).map((seg, i, arr) => (
                    <span key={`${i}-${seg}`}>
                      <span className="crumb-sep">/</span>
                      <button onClick={() => void loadDir(arr.slice(0, i + 1).join("/"))}>{seg}</button>
                    </span>
                  ))}
                </div>
                {fileLoading && <div className="dock-empty">读取中…</div>}
                {previewLoading && <div className="dock-empty">读取文件…</div>}
                {preview ? (
                  <>
                    <div className="preview-head">
                      <button
                        onClick={() => {
                          setPreview(null);
                          setFileInfo(null);
                        }}
                      >
                        ← 列表
                      </button>
                      <span className="preview-name" title={preview.path}>
                        {preview.path.split("/").pop() || preview.path}
                      </span>
                    </div>
                    <div className="preview-meta">
                      {formatSize(preview.size)}
                      {fileInfo?.mtime ? ` · ${new Date(fileInfo.mtime).toLocaleString()}` : ""}
                    </div>
                    <FilePreview result={preview} />
                  </>
                ) : (
                  <>
                    {fileList?.error && <div className="dock-error">{fileList.error}</div>}
                    {fileList && !fileList.error && (
                      <>
                        {fileList.entries.length === 0 && <div className="dock-empty">空目录</div>}
                        <ul className="dock-list">
                          {fileList.entries.map((e) => (
                            <li key={e.path}>
                              <button
                                className={`dock-entry ${e.type}`}
                                title={e.path}
                                onClick={() => (e.type === "dir" ? void loadDir(e.path) : void selectFile(e.path))}
                              >
                                <span className="dock-name">
                                  {e.type === "dir" ? "▸ " : ""}
                                  {e.name}
                                  {e.symlink ? " ↗" : ""}
                                </span>
                                {e.type === "file" && e.size !== undefined && (
                                  <span className="dock-meta">{formatSize(e.size)}</span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                        {fileList.truncated && <div className="dock-note">只列出前 1000 条</div>}
                      </>
                    )}
                  </>
                )}
                <div className="dock-note">只读。不列 .git、node_modules、.omcp。</div>
              </div>
        )}
        artifacts={(

              <div className="dock-empty">
                <b>产物列表还没接入</b>
                <p>以后只扫描 figures/ 和 results/，不解释科学结论。</p>
              </div>
        )}
        run={(
              <div className="dock-run">
                <div className="dock-note">内核与方案门（只读）。首次运行代码时内核才会启动。</div>
              </div>
        )}
        notebook={<Notebook />}
      />
      {overlay && (
        <div className="overlay-backdrop" onClick={() => setOverlay(null)}>
          <div
            className="overlay"
            role="dialog"
            aria-modal="true"
            aria-label={OVERLAY_TITLE[overlay]}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="overlay-head">
              <strong>{OVERLAY_TITLE[overlay]}</strong>
              <button onClick={() => setOverlay(null)} aria-label="关闭">
                ×
              </button>
            </div>
            <div className="overlay-body">
              {/* 浮层遮住了主区横幅，只读时在浮层里再放一份 */}
              {policy?.mode === "readonly" && <ReadonlyBanner />}
              {overlay === "permissions" && <Permissions />}
              {overlay === "skills" && <Skills />}
              {overlay === "settings" && <Settings />}
            </div>
          </div>
        </div>
      )}
      {approval && <ApprovalModal request={approval} onRespond={respondApproval} />}
      {setupProvider && (
        <ProviderSetupDialog
          provider={setupProvider}
          initialModelId={modelKey.startsWith(setupProvider + "/") ? modelKey.slice(setupProvider.length + 1) : undefined}
          onClose={() => setSetupProvider(null)}
          onSaved={() => {
            setSetupProvider(null);
            void refreshState();
          }}
        />
      )}
    </div>
  );
}
