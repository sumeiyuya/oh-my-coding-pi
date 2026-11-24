import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Notebook from "./Notebook";
import Permissions from "./Permissions";
import Settings from "./Settings";
import PermissionPill from "./PermissionPill";
import ModelPicker from "./ModelPicker";
import ThinkingPicker from "./ThinkingPicker";
import FileTree from "./FileTree";
import LangBadge from "./LangBadge";
import Sash from "./Sash";
import RightDock from "./RightDock";
import ArtifactsPane from "./ArtifactsPane";
import QueueBar from "./QueueBar";
import { EMPTY_QUEUE, flattenQueue, joinTakeBack, planRedirect, removeQueuedMessages, type QueueSnapshot } from "./queue";
import StatusBar from "./StatusBar";
import {
  UI_LIMITS,
  clampWidth,
  loadUiState,
  saveUiState,
  type DockTab,
} from "./ui-state";
import ProviderSetupDialog from "./ProviderSetupDialog";
import ContextMeter from "./ContextMeter";
import Skills from "./Skills";
import Route from "./Route";
import ApprovalModal from "./ApprovalModal";
import FilePreview from "./FilePreview";
import Markdown from "./Markdown";
import UploadMenu from "./UploadMenu";
import ToolCard from "./ToolCard";
import ToolGroup from "./ToolGroup";
import { messagesFromAgent } from "./tool-rebuild";
import { groupAdjacent, type ToolItem } from "./tool-summary";
import { copyText } from "./clipboard";
import { describeModelError, modelErrorLine, type ModelErrorInfo } from "./model-error";
import ErrorBanner from "./ErrorBanner";
import { presentAppError, presentModelError } from "./error-view";
import { applyMention, mentionInsert, mentionQueryParts, parseMention } from "./mention";
import { TABS_KEY, TABS_MAX, pruneTabs, pushTab, sanitizeTabs } from "./session-tabs";
import {
  UPLOAD_IMAGE_MAX_BYTES,
  UPLOAD_IMAGE_MAX_COUNT,
  UPLOAD_IMAGE_TOTAL_BYTES,
} from "@oh-my-coding-pi/shared";
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
  PickedUpload,
  UploadKind,
  FileEntry,
  FileReadResult,
  FileStatResult,
  ImageAttachment,
  RuntimeView,
  SessionBoardView,
  SessionOpenView,
  SessionView,
  ThinkingLevel,
  WorkspaceInfo,
  WorkspaceIndexEntry,
} from "@oh-my-coding-pi/shared";

type UserImage = { id: string; data: string; mimeType: string };

type Msg = { id?: string } & (
  | {
      kind: "user";
      text: string;
      /** pi 没有接受这条消息 */
      failed?: boolean;
      /** 发送时附的图片；历史恢复也会带上 */
      attachments?: UserImage[];
      /** 发送时模型只收文本：图片已转述 */
      textOnly?: boolean;
    }
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
  | { kind: "system"; text: string }
);

/** 提交阶段：只覆盖“用户按下发送 → 模型开始出字”这一段，出字后交给 busy/流式 */
type SubmitPhase = "idle" | "submitting" | "accepted" | "preparing" | "running" | "streaming";

const SUBMIT_LABEL: Record<SubmitPhase, string> = {
  idle: "",
  submitting: "正在发送…",
  accepted: "正在检查预算…",
  preparing: "正在准备上下文（可能包含自动压缩）…",
  running: "模型处理中…",
  streaming: "",
};

let msgSeq = 0;
function nextMsgId(): string {
  msgSeq = (msgSeq + 1) % 1_000_000;
  return `m${Date.now().toString(36)}-${msgSeq.toString(36)}`;
}

/** 相对时间（修改 3）：2m / 3h / 2d；超过一周回落到日期 */
function formatRelative(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h`;
  const day = Math.floor(hour / 24);
  if (day <= 7) return `${day}d`;
  return new Date(t).toLocaleDateString();
}

/** 工作区显示名：最后一段目录；根路径兜底 */
function workspaceLabel(root: string | undefined): string {
  if (!root) return "未打开工作区";
  const parts = root.split(String.fromCharCode(92)).join("/").split("/").filter(Boolean);
  return parts[parts.length - 1] || root;
}

/** 文件树展开状态的存储键：路径太长，取短哈希避免 localStorage 键失控 */
function fileTreeKey(root: string): string {
  let hash = 5381;
  for (let i = 0; i < root.length; i++) hash = ((hash << 5) + hash + root.charCodeAt(i)) | 0;
  return `omcp.fileTree.${Math.abs(hash).toString(36)}`;
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

const DOCK_LABEL: Record<DockTab, string> = {
  files: "文件",
  notebook: "笔记本",
  artifacts: "产物",
  run: "运行",
};

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

/** 工具输出只看尾部：长命令的进展在最后几行 */
function tailText(text: string, max: number): string {
  return text.length <= max
    ? text
    : `…（较早输出已省略）
${text.slice(-max)}`;
}

function toMsgs(list: AgentMessage[]): Msg[] {
  // 工具调用是转写的一部分：从 tool_use / tool_result 块重建（修改 4）
  return messagesFromAgent(list) as Msg[];
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
  const [messagesByRuntime, setMessagesByRuntime] = useState<Record<string, Msg[]>>({});
  const [activeRuntimeId, setActiveRuntimeId] = useState("default");
  const activeRuntimeRef = useRef("default");
  const messages = messagesByRuntime[activeRuntimeId] ?? [];

  function setMessagesFor(
    runtimeId: string,
    updater: Msg[] | ((prev: Msg[]) => Msg[]),
  ): void {
    setMessagesByRuntime((prev) => {
      const current = prev[runtimeId] ?? [];
      const next = typeof updater === "function" ? updater(current) : updater;
      return { ...prev, [runtimeId]: next };
    });
  }

  /** 当前标签的 setter；事件回调用 runtimeId 指定，不靠猜 */
  function setMessages(updater: Msg[] | ((prev: Msg[]) => Msg[])): void {
    setMessagesFor(activeRuntimeRef.current, updater);
  }

  /** 非 active runtime 的轻量转写：只保留 assistant 文本与工具行；切回时会用 get_messages 校正 */
  async function refreshStatsFor(runtimeId: string): Promise<void> {
    try {
      const stats = (runtimeId === "default"
        ? await window.api.getStats()
        : await window.api.getRuntimeStats(runtimeId)) as SessionStats | null;
      setStatsByRuntime((prev) => ({ ...prev, [runtimeId]: stats }));
      if (runtimeId === activeRuntimeRef.current) setStats(stats);
    } catch {
      // ignore
    }
  }

  function applyBackgroundEvent(runtimeId: string, ev: PiEvent): void {
    if (ev.type === "agent_start") {
      setBusyFor(runtimeId, true);
      return;
    }
    if (ev.type === "agent_settled") {
      setBusyFor(runtimeId, false);
      void refreshStatsFor(runtimeId);
      return;
    }
    if (ev.type === "queue_update") {
      setQueueByRuntime((prev) => ({
        ...prev,
        [runtimeId]: { steering: ev.steering ?? [], followUp: ev.followUp ?? [] },
      }));
      return;
    }
    if (ev.type === "message_start" && ev.message.role === "assistant") {
      setMessagesFor(runtimeId, (prev) => [
        ...prev,
        { kind: "assistant", text: "", id: `${runtimeId}-${Date.now()}` },
      ]);
      return;
    }
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      const delta = ev.assistantMessageEvent.delta;
      setMessagesFor(runtimeId, (prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const item = next[i]!;
          if (item.kind === "assistant") {
            next[i] = { ...item, text: item.text + delta };
            return next;
          }
        }
        return [...next, { kind: "assistant", text: delta, id: `${runtimeId}-${Date.now()}` }];
      });
      return;
    }
    if (ev.type === "message_end" && ev.message.role === "assistant") {
      const text = textOf(ev.message.content);
      setMessagesFor(runtimeId, (prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const item = next[i]!;
          if (item.kind === "assistant") {
            next[i] = { ...item, text: text || item.text };
            return next;
          }
        }
        return text ? [...next, { kind: "assistant", text, id: `${runtimeId}-${Date.now()}` }] : next;
      });
      setUnreadByRuntime((prev) => ({ ...prev, [runtimeId]: (prev[runtimeId] ?? 0) + 1 }));
      return;
    }
    if (ev.type === "tool_execution_start") {
      setMessagesFor(runtimeId, (prev) => [
        ...prev,
        {
          kind: "tool",
          id: ev.toolCallId,
          name: ev.toolName,
          args: JSON.stringify(ev.args ?? {}),
          done: false,
          startedAt: Date.now(),
        },
      ]);
      return;
    }
    if (ev.type === "tool_execution_end") {
      setMessagesFor(runtimeId, (prev) =>
        prev.map((item) =>
          item.kind === "tool" && item.id === ev.toolCallId
            ? {
                ...item,
                done: true,
                endedAt: Date.now(),
                ...(ev.isError ? { isError: true } : {}),
                result: textOf(ev.result?.content as never),
              }
            : item,
        ),
      );
    }
  }
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [workspaceIndex, setWorkspaceIndex] = useState<WorkspaceIndexEntry[]>([]);
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(
    () => new Set(loadUiState().expandedWorkspaces),
  );
  const [menuFor, setMenuFor] = useState<string | null>(null);
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
  const [inputByRuntime, setInputByRuntime] = useState<Record<string, string>>({});
  const input = inputByRuntime[activeRuntimeId] ?? "";
  function setInput(value: string | ((prev: string) => string)): void {
    const runtimeId = activeRuntimeRef.current;
    setInputByRuntime((prev) => {
      const current = prev[runtimeId] ?? "";
      const next = typeof value === "function" ? value(current) : value;
      return { ...prev, [runtimeId]: next };
    });
  }

  /** 待发队列以 pi 的 queue_update 为准（修改 2） */
  const [queueByRuntime, setQueueByRuntime] = useState<Record<string, QueueSnapshot>>({});
  const queue = queueByRuntime[activeRuntimeId] ?? EMPTY_QUEUE;
  function setQueue(value: QueueSnapshot | ((prev: QueueSnapshot) => QueueSnapshot)): void {
    const runtimeId = activeRuntimeRef.current;
    setQueueByRuntime((prev) => {
      const current = prev[runtimeId] ?? EMPTY_QUEUE;
      const next = typeof value === "function" ? value(current) : value;
      return { ...prev, [runtimeId]: next };
    });
  }
  const newSessionIntent = useRef<string | null>(null);
  const [busyByRuntime, setBusyByRuntime] = useState<Record<string, boolean>>({});
  const busy = busyByRuntime[activeRuntimeId] ?? false;

  function setBusyFor(runtimeId: string, value: boolean): void {
    setBusyByRuntime((prev) => (prev[runtimeId] === value ? prev : { ...prev, [runtimeId]: value }));
  }

  function setBusy(value: boolean): void {
    setBusyFor(activeRuntimeRef.current, value);
  }
  /** 提交阶段：发送锁与“准备中”文案都看它 */
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("idle");
  /** 本轮待确认的用户消息：失败时标记未送达并回填输入框 */
  const pendingUser = useRef<{
    id: string;
    text: string;
    attachments: Array<{ id: string; data: string; mimeType: string }>;
  } | null>(null);
  const [status, setStatus] = useState<BridgeStatus>("starting");
  /** pi 进程已启动但可能仍在初始化；只有 RPC 真正响应过才允许发送 */
  const [piReady, setPiReady] = useState(false);
  const piReadyRef = useRef(false);
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [statsByRuntime, setStatsByRuntime] = useState<Record<string, SessionStats | null>>({});
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelKey, setModelKey] = useState("");
  /** pi 当前会话实际生效的推理档；null = 还没读到 state */
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel | null>(null);
  /** 预检不通过时，就地打开「确认连接信息 + 存 key」对话框（PR2） */
  const [setupProvider, setSetupProvider] = useState<string | null>(null);
  const [tab, setTab] = useState<"sessions" | "tree">("sessions");
  const [tree, setTree] = useState<SessionTreeResult | null>(null);
  const [notice, setNotice] = useState("");
  const [runtimes, setRuntimes] = useState<RuntimeView[]>([]);
  const runtimesRef = useRef<RuntimeView[]>([]);
  /** 修改 4 · M0：会话 + 槽的权威表（主进程给） */
  const [board, setBoard] = useState<SessionBoardView | null>(null);
  /**
   * 修改 4 · M0：可发送与否要看**当前这个槽**。
   * `piReady` 只反映默认槽（它是启动时的那个进程）；后台槽挂起/恢复时
   * 不能拿它当全局开关，否则切到后台标签会被误判成"pi 正在启动"。
   */
  const activeSlotInfo = board?.slots.find((item) => item.id === activeRuntimeId);
  const slotReady = activeRuntimeId === "default" ? piReady : Boolean(activeSlotInfo?.ready);

  const [unreadByRuntime, setUnreadByRuntime] = useState<Record<string, number>>({});
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
  /** 右坞开/合是自己的偏好（无布局模式后不再靠“选模式”顺带打开），随 ui-state 落盘 */
  const [ui, setUi] = useState(loadUiState);
  const [dockOpen, setDockOpen] = useState(ui.dockOpen);
  const [sessionQuery, setSessionQuery] = useState("");
  /** 文件树：展开的目录（根 "" 总在）、选中的文件；按工作区持久化 */
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([""]));
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
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
  const dockSwitchRef = useRef<HTMLButtonElement>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [attachmentsByRuntime, setAttachmentsByRuntime] = useState<Record<string, UserImage[]>>({});
  const attachments = attachmentsByRuntime[activeRuntimeId] ?? [];
  function setAttachments(value: UserImage[] | ((prev: UserImage[]) => UserImage[])): void {
    const runtimeId = activeRuntimeRef.current;
    setAttachmentsByRuntime((prev) => {
      const current = prev[runtimeId] ?? [];
      const next = typeof value === "function" ? value(current) : value;
      return { ...prev, [runtimeId]: next };
    });
  }
  const [imagePreview, setImagePreview] = useState<UserImage | null>(null);
  /** 正在复制的外部文件：进度与取消都看它 */
  const [uploading, setUploading] = useState<{ id: string; name: string; percent: number } | null>(
    null,
  );
  const [policy, setPolicy] = useState<PolicyInfo | null>(null);
  const pendingText = useRef("");
  /** 工具中间输出节流：同一 toolCallId 最快 150 ms 更新一次 */
  const toolUpdateAt = useRef<Record<string, number>>({});
  /** 流式期间的客户端性能采样（长任务 + 帧间隔），只写 window.__omcpPerf 供自检读取 */
  const clientPerf = useRef<{
    start: number;
    longTasks: number;
    longMs: number;
    frames: number;
    maxGap: number;
    over50: number;
  } | null>(null);
  const clientRaf = useRef<number | null>(null);
  const clientObserver = useRef<PerformanceObserver | null>(null);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.api.getSessions(activeRuntimeRef.current));
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

  const refreshWorkspaceIndex = useCallback(async () => {
    try {
      setWorkspaceIndex(await window.api.getWorkspaceIndex());
    } catch {
      setWorkspaceIndex([]);
    }
  }, []);

  useEffect(() => {
    void refreshWorkspaceIndex();
  }, [workspace?.root, sessions.length, refreshWorkspaceIndex]);

  const refreshModels = useCallback(async () => {
    try {
      setModels(await window.api.getAvailableModels());
    } catch {
      // pi 未就绪时保留旧列表
    }
  }, []);

  /** 当前助手消息的字符数：用于长回复降频（不是精确 token 数，只做阈值判断） */
  const streamChars = useRef(0);

  const appendAssistantText = useCallback((chunk: string) => {
    setMessages((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        const cur = next[i];
        if (cur.kind === "assistant") {
          const text = cur.text + chunk;
          streamChars.current = text.length;
          next[i] = { ...cur, text };
          return next;
        }
      }
      streamChars.current = chunk.length;
      return [...next, { kind: "assistant", text: chunk, id: nextMsgId() }];
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
      // 长回复降频：解析成本随文本增长，尾部仍保持流式感
      const chars = streamChars.current;
      const delay = chars > 12000 ? 90 : chars > 6000 ? 60 : 40;
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        const text = pendingText.current;
        pendingText.current = "";
        if (text) appendAssistantText(text);
      }, delay);
    },
    [appendAssistantText],
  );

  const refreshStats = useCallback(async () => {
    const runtimeId = activeRuntimeRef.current;
    try {
      const stats = (runtimeId === "default"
        ? await window.api.getStats()
        : await window.api.getRuntimeStats(runtimeId)) as SessionStats | null;
      setStats(stats);
      setStatsByRuntime((prev) => ({ ...prev, [runtimeId]: stats }));
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
      setThinkingLevel(state.thinkingLevel ?? null);
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
    // 后台标签激活时不要把默认会话的消息灌进来
    if (activeRuntimeRef.current !== "default") return;
    // 切会话前把未落屏的 delta 丢掉，否则它会拼到新会话的最后一条回复上
    discardPendingText();
    streamChars.current = 0;
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

  function runtimeLabel(id?: string): string | undefined {
    if (!id) return undefined;
    if (id === "default") return "默认";
    const index = runtimes.findIndex((item) => item.id === id);
    return index >= 0 ? `后台 ${index}` : "后台";
  }

  function applyRuntimeList(list: RuntimeView[]): void {
    const previous = runtimesRef.current;
    for (const item of list) {
      if (item.id === "default") continue;
      const before = previous.find((x) => x.id === item.id);
      if (before?.running && !item.running) {
        setNotice("后台 runtime 已挂起（空闲回收）；切回标签会自动恢复。");
      } else if (before && !before.running && item.running) {
        setNotice("后台 runtime 已恢复。");
      }
    }
    runtimesRef.current = list;
    setRuntimes(list);
  }

  const refreshRuntimes = useCallback(async () => {
    try {
      applyRuntimeList(((await window.api.listRuntimes()) as RuntimeView[]) ?? []);
    } catch {
      applyRuntimeList([]);
    }
  }, []);

  useEffect(() => {
    void refreshRuntimes();
  }, [refreshRuntimes]);

  useEffect(() => {
    return window.api.onRuntimeChanged((list) => {
      applyRuntimeList((list as RuntimeView[]) ?? []);
    });
  }, []);

  // 修改 4 · M0：会话表由主进程推；渲染端不再自己算"谁在跑"
  useEffect(() => {
    let alive = true;
    void window.api
      .getSessionBoard()
      .then((next) => {
        if (alive) setBoard(next as SessionBoardView);
      })
      .catch(() => undefined);
    const off = window.api.onSessionChanged((next) => setBoard(next as SessionBoardView));
    const offOpen = window.api.onSessionOpened((payload) => {
      const file = (payload as { file?: string }).file;
      if (file) setNotice(`排队的会话已空出位置并打开：${file.split(/[\/]/).pop() ?? file}`);
    });
    return () => {
      alive = false;
      off();
      offOpen();
    };
  }, []);

  /** 某个会话文件在权威表里的那一行（标签状态点、未读都读它） */
  function sessionViewFor(file: string | null): SessionView | undefined {
    if (!file || !board) return undefined;
    return board.sessions.find((item) => item.file === file);
  }

  const activateRuntime = useCallback(
    async (id: string) => {
      activeRuntimeRef.current = id;
      setActiveRuntimeId(id);
      setUnreadByRuntime((prev) => ({ ...prev, [id]: 0 }));
      try {
        const list = (await window.api.activateRuntime(id)) as RuntimeView[];
        if (list) applyRuntimeList(list);
      } catch {
        // 主进程不可用时仍允许看本地缓冲
      }
      if (id !== "default" || !messagesByRuntime[id]) {
        try {
          const list = (await window.api.getRuntimeMessages(id)) as AgentMessage[];
          setMessagesFor(id, toMsgs(list));
        } catch {
          // runtime 可能刚被回收、正在 resume；等一拍再试一次
          await new Promise((resolve) => setTimeout(resolve, 900));
          try {
            const list = (await window.api.getRuntimeMessages(id)) as AgentMessage[];
            setMessagesFor(id, toMsgs(list));
          } catch {
            setMessagesFor(id, []);
          }
        }
      }
      try {
        const state = (await window.api.getRuntimeState(id)) as {
          model?: { provider?: string; id?: string };
          thinkingLevel?: ThinkingLevel | null;
        } | null;
        const m = state?.model;
        const usable = m && m.provider && m.id && m.provider !== "unknown" && m.id !== "unknown";
        setModelKey(usable ? `${m.provider}/${m.id}` : "");
        setThinkingLevel(state?.thinkingLevel ?? null);
        const stats = (await window.api.getRuntimeStats(id)) as SessionStats | null;
        if (stats) {
          setStats(stats);
          setStatsByRuntime((prev) => ({ ...prev, [id]: stats }));
        }
        setSessions(await window.api.getSessions(id));
      } catch {
        // 后台 runtime 可能还没就绪；保留当前显示
      }
    },
    [messagesByRuntime],
  );

  const createRuntime = useCallback(async () => {
    try {
      const view = (await window.api.createRuntime({})) as RuntimeView | null;
      await refreshRuntimes();
      if (view) await activateRuntime(view.id);
    } catch (error) {
      setNotice(`创建后台运行时失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [activateRuntime, refreshRuntimes]);

  const closeRuntime = useCallback(
    async (id: string) => {
      if (id === "default") return;
      try {
        await window.api.closeRuntime(id);
        setMessagesByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setUnreadByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setBusyByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setInputByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setAttachmentsByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setQueueByRuntime((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await refreshRuntimes();
        if (activeRuntimeRef.current === id) await activateRuntime("default");
      } catch (error) {
        setNotice(`关闭后台运行时失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [activateRuntime, refreshRuntimes],
  );

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
      // P2a：其他 runtime 的事件先丢掉，避免污染默认会话；P2b 会按 activeRuntimeId 分流
      const runtimeId = (raw as unknown as { runtimeId?: unknown }).runtimeId;
      const ev = raw as PiEvent;
      if (typeof runtimeId === "string" && runtimeId !== activeRuntimeRef.current) {
        applyBackgroundEvent(runtimeId, ev);
        return;
      }

      switch (ev.type) {
        case "queue_update":
          setQueue({ steering: ev.steering ?? [], followUp: ev.followUp ?? [] });
          return;
        case "agent_start":
          setBusy(true);
          setSubmitPhase("running");
          startClientPerf();
          return;
        case "agent_settled": {
          stopClientPerf();
          setBusy(false);
          setSubmitPhase("idle");
          toolUpdateAt.current = {};
          const intent = newSessionIntent.current;
          if (intent) {
            newSessionIntent.current = null;
            void (async () => {
              const ok = await window.api.newSession(activeRuntimeRef.current).catch(() => false);
              if (ok) {
                setMessages((prev) => [...prev, { kind: "user", text: intent }]);
                await window.api.prompt(intent).catch(() => undefined);
              } else {
                setInput((prev) => joinTakeBack([intent], prev));
                setNotice("新开会话失败，这句已放回输入框");
              }
            })();
          }
          void refreshStats();
          void refreshState();
          void refreshSessions();
          void refreshTree();
          void refreshBudget();
          return;
        }
        case "message_start":
          if (ev.message.role === "assistant") {
            discardPendingText();
            setSubmitPhase("streaming");
            streamChars.current = 0;
            setMessages((prev) => [...prev, { kind: "assistant", text: "", id: nextMsgId() }]);
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
                if (text) {
                  streamChars.current = text.length;
                  next[i] = { ...cur, text };
                } else if (!cur.text) next.splice(i, 1);
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
        case "tool_execution_update": {
          const now = Date.now();
          const last = toolUpdateAt.current[ev.toolCallId] ?? 0;
          if (now - last < 150) return;
          toolUpdateAt.current[ev.toolCallId] = now;
          const partial = textOf(ev.partialResult.content);
          if (!partial) return;
          setMessages((prev) =>
            prev.map((m) =>
              m.kind === "tool" && m.id === ev.toolCallId ? { ...m, result: tailText(partial, 1200) } : m,
            ),
          );
          return;
        }
        case "tool_execution_end":
          setMessages((prev) => {
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              const cur = next[i];
              if (cur.kind === "tool" && cur.id === ev.toolCallId) {
                delete toolUpdateAt.current[ev.toolCallId];
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

    const offUpload = window.api.onUploadProgress((p) => {
      setUploading((cur) =>
        cur && cur.id === p.importId
          ? {
              ...cur,
              name: p.file,
              percent: p.totalBytes > 0 ? Math.round((p.copiedBytes / p.totalBytes) * 100) : 0,
            }
          : cur,
      );
    });

    const offTurn = window.api.onTurnPhase((ev) => {
      switch (ev.phase) {
        case "accepted":
          setSubmitPhase((p) => (p === "idle" ? p : "accepted"));
          return;
        case "preparing":
          setSubmitPhase((p) => (p === "idle" ? p : "preparing"));
          return;
        case "started":
          setSubmitPhase("running");
          setBusy(true);
          return;
        case "first_token":
          setSubmitPhase("streaming");
          return;
        case "settled":
          setSubmitPhase("idle");
          return;
        case "failed":
          // 具体原因由 prompt 返回值收尾（未送达标记 + 输入恢复）；这里只解除锁定
          setSubmitPhase("idle");
          return;
        default:
          return;
      }
    });

    const applyReady = (ready: boolean) => {
      const was = piReadyRef.current;
      piReadyRef.current = ready;
      setPiReady(ready);
      // 第一次真正可响应时补拉一次：启动期的请求多半已经超时
      if (ready && !was) {
        void refreshSession();
        void refreshModels();
      }
    };
    const offPiReady = window.api.onPiReady(applyReady);
    void window.api.isPiReady().then(applyReady).catch(() => undefined);

    const offStatus = window.api.onStatus((s) => {
      setStatus(s);
      if (s === "starting" || s === "restarting" || s === "stopped" || s === "error") {
        applyReady(false);
      }
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
      offTurn();
      offUpload();
      offPiReady();
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
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".session-menu") || target?.closest(".session-more")) return;
      setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor]);

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

  const loadTreeDir = useCallback((path: string) => window.api.listFiles(path), []);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  function openFromTree(path: string) {
    setSelectedPath(path);
    void selectFile(path);
  }

  /** 产物面板的「在文件中显示」：先逐级展开父目录，再选中并预览 */
  function revealInTree(path: string) {
    const segments = path.split("/").filter(Boolean);
    const parents = [""];
    for (let i = 1; i < segments.length; i++) parents.push(segments.slice(0, i).join("/"));
    setExpandedDirs((prev) => new Set([...prev, ...parents]));
    setSelectedPath(path);
    setDockTab("files");
    void selectFile(path);
  }

  /** 读过的存储键：避免“加载前”的初始值把旧展开状态覆盖掉 */
  const fileTreeLoaded = useRef<string | null>(null);

  // 换工作区：展开状态按工作区分键读取；选中与预览清空
  useEffect(() => {
    const root = workspace?.root ?? "";
    setSelectedPath(null);
    setPreview(null);
    setFileInfo(null);
    if (!root) {
      fileTreeLoaded.current = null;
      setExpandedDirs(new Set([""]));
      return;
    }
    let next = new Set<string>([""]);
    try {
      const raw = localStorage.getItem(fileTreeKey(root));
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        for (const item of parsed) if (typeof item === "string") next.add(item);
      }
    } catch {
      // 坏数据就当没存过
    }
    fileTreeLoaded.current = root;
    setExpandedDirs(next);
  }, [workspace?.root]);

  useEffect(() => {
    const root = workspace?.root;
    if (!root || fileTreeLoaded.current !== root) return;
    try {
      localStorage.setItem(fileTreeKey(root), JSON.stringify([...expandedDirs].slice(0, 200)));
    } catch {
      // 写不进去只影响下次展开状态
    }
  }, [expandedDirs, workspace?.root]);

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

  useEffect(() => {
    if (!imagePreview) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setImagePreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [imagePreview]);

  function startClientPerf() {
    // 默认不采样：只有自检/诊断显式打开 window.__omcpPerfEnabled 才跑
    if ((window as unknown as { __omcpPerfEnabled?: boolean }).__omcpPerfEnabled !== true) return;
    if (clientPerf.current) return;
    const state = { start: performance.now(), longTasks: 0, longMs: 0, frames: 0, maxGap: 0, over50: 0 };
    clientPerf.current = state;
    try {
      const po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          state.longTasks += 1;
          state.longMs += entry.duration;
        }
      });
      po.observe({ entryTypes: ["longtask"] });
      clientObserver.current = po;
    } catch {
      // 老 Chromium 没有 longtask，只保留帧间隔
    }
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const gap = now - last;
      last = now;
      state.frames += 1;
      if (gap > state.maxGap) state.maxGap = gap;
      if (gap > 50) state.over50 += 1;
      clientRaf.current = requestAnimationFrame(tick);
    };
    clientRaf.current = requestAnimationFrame(tick);
  }

  function stopClientPerf() {
    const s = clientPerf.current;
    clientPerf.current = null;
    if (clientRaf.current !== null) cancelAnimationFrame(clientRaf.current);
    clientRaf.current = null;
    clientObserver.current?.disconnect();
    clientObserver.current = null;
    if (!s) return;
    const elapsedMs = Math.round(performance.now() - s.start);
    const metrics = {
      elapsedMs,
      frames: s.frames,
      avgFrameGapMs: s.frames > 0 ? Math.round((elapsedMs / s.frames) * 10) / 10 : null,
      longTasks: s.longTasks,
      longMs: Math.round(s.longMs),
      longTaskSupported:
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask"),
      maxFrameGapMs: Math.round(s.maxGap),
      framesOver50ms: s.over50,
    };
    (window as unknown as { __omcpPerf?: unknown }).__omcpPerf = metrics;
  }

  /** 失败收尾：标记未送达、把文字放回输入框；预检失败时不再重复追加系统消息 */
  function failSend(detail: string, hint = "", addSystem = true) {
    const pending = pendingUser.current;
    pendingUser.current = null;
    setSubmitPhase("idle");
    if (pending) {
      setMessages((prev) =>
        prev.map((m) => (m.kind === "user" && m.id === pending.id ? { ...m, failed: true } : m)),
      );
      setInput((prev) => joinTakeBack([pending.text], prev));
      if (currentFile) draftsRef.current[currentFile] = pending.text;
      if (pending.attachments.length) setAttachments(pending.attachments);
    }
    if (addSystem) setMessages((prev) => [...prev, { kind: "system", text: detail + hint }]);
  }

  async function send(mode: "prompt" | "steer" | "followUp") {
    const text = input.trim();
    if (!text) return;
    if (!slotReady) {
      setNotice("这个会话的 pi 正在启动，请稍候再发送");
      return;
    }
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
    const isPrompt = mode === "prompt";
    // 提交期间锁住发送：连续点击会让 pi 报 “Agent is already processing”
    if (isPrompt && (submitPhase !== "idle" || busy)) return;

    const msgId = nextMsgId();
    const pendingAttachments = attachments;
    if (isPrompt) {
      pendingUser.current = { id: msgId, text, attachments: pendingAttachments };
      setSubmitPhase("submitting");
    }
    setMessages((prev) => [
      ...prev,
      {
        kind: "user",
        text,
        id: msgId,
        ...(isPrompt && pendingAttachments.length ? { attachments: pendingAttachments } : {}),
        ...(isPrompt && !modelSupportsImage && pendingAttachments.length ? { textOnly: true } : {}),
      },
    ]);
    setInput("");
    setMention(null);
    setMentionEntries([]);
    // 发出去就不再算草稿，否则切走再切回来会把已发送的文字又填回输入框
    if (currentFile) draftsRef.current[currentFile] = "";
    setAttachments([]);

    if (isPrompt) {
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
          failSend(pf.message, "", false);
          return;
        }
      } catch {
        // 预检自身失败不阻断发送：pi 那边还有一道真实校验
      }
      setModelError(null);
      setSubmitPhase("accepted");
    }

    try {
      const res =
        mode === "steer"
          ? await window.api.steer(text, activeRuntimeRef.current)
          : mode === "followUp"
            ? await window.api.followUp(text, activeRuntimeRef.current)
            : await window.api.prompt(
                text,
                pendingAttachments.length
                  ? pendingAttachments.map((a): ImageAttachment => ({
                      type: "image",
                      data: a.data,
                      mimeType: a.mimeType,
                    }))
                  : undefined,
                undefined,
                activeRuntimeRef.current,
              );
      if (!res.ok) {
        // pi 的拒绝原因要原样给出来（例如缺密钥、未知 provider），
        // 只说“消息未被接受”等于把唯一有用的信息丢掉。
        const detail = res.error ?? "pi 未说明原因";
        const hint = /no api key/i.test(detail)
          ? `
提示：去「设置 → 模型注册表」给这个 provider 保存密钥；改完密钥会自动重启 pi。`
          : /unknown provider|model not found/i.test(detail)
            ? `
提示：pi 不认识这个 provider/模型，去「设置 → 模型注册表」确认已保存并同步到 models.json。`
            : "";
        if (isPrompt) failSend(`消息未被接受：${detail}`, hint);
        else setMessages((prev) => [...prev, { kind: "system", text: `消息未被接受：${detail}${hint}` }]);
        return;
      }
      if (isPrompt) pendingUser.current = null;
    } catch {
      if (isPrompt) failSend("发送失败，请检查 pi 状态");
      else setMessages((prev) => [...prev, { kind: "system", text: "发送失败，请检查 pi 状态" }]);
    }
  }

  /** 取回待发：文本回到输入框，转写里对应的气泡一起撤掉 */
  async function takeBackQueue(toInput = true): Promise<string[]> {
    const res = await window.api.clearQueue(activeRuntimeRef.current).catch(() => ({ ok: false, steering: [], followUp: [] }));
    const texts = [...res.steering, ...res.followUp];
    if (!texts.length) return [];
    setQueue(EMPTY_QUEUE);
    if (toInput) setInput((prev) => joinTakeBack(texts, prev));
    setMessages((prev) => removeQueuedMessages(prev, texts) as typeof prev);
    return texts;
  }

  /** 某一条立刻转向：取回全部，再按原顺序重投（pi 的队列没有单条 id） */
  async function redirectQueued(index: number) {
    const texts = await takeBackQueue(false);
    if (!texts.length) return;
    const plan = planRedirect({ steering: [], followUp: texts }, index);
    if (!plan) return;
    setMessages((prev) => [...prev, ...texts.map((text) => ({ kind: "user" as const, text }))]);
    await window.api.steer(plan.steer, activeRuntimeRef.current).catch(() => undefined);
    for (const text of plan.followUp) await window.api.followUp(text, activeRuntimeRef.current).catch(() => undefined);
  }

  /** 这一轮结束后另起会话：其余几条放回输入框，不静默丢 */
  async function queueToNewSession(index: number) {
    const texts = await takeBackQueue(false);
    const target = texts[index];
    if (!target) return;
    const rest = texts.filter((_, i) => i !== index);
    if (rest.length) setInput((prev) => joinTakeBack(rest, prev));
    newSessionIntent.current = target;
    setNotice("这一轮结束后会新开会话并发送这句");
  }

  async function changeModel(provider: string, modelId: string): Promise<{ ok: boolean; error?: string }> {
    // 只有 pi 真的接受了才更新界面：没配 key 或模型不存在时不能显示成换过了
    const res = await window.api.setModel(provider, modelId, activeRuntimeRef.current).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (res.ok) {
      if (activeRuntimeRef.current === "default") await refreshState();
      else setModelKey(`${provider}/${modelId}`);
      return { ok: true };
    }
    setModelError(describeModelError(res.error ?? "切换模型失败"));
    return { ok: false, error: res.error ?? "切换模型失败" };
  }

  /** 顶栏推理强度：只有 pi 接受才更新显示（与切模型同一纪律） */
  async function changeThinkingLevel(level: ThinkingLevel): Promise<{ ok: boolean; error?: string }> {
    const res = await window.api.setThinkingLevel(level, activeRuntimeRef.current).catch((err: unknown) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (res.ok) {
      setThinkingLevel(level);
      return { ok: true };
    }
    return { ok: false, error: res.error ?? "切换推理强度失败" };
  }

  const loadThinkingLevels = useCallback((): Promise<ThinkingLevel[]> => {
    // 不在这里吞异常：「pi 未响应」与「模型没有可调档位」必须能被组件区分
    return window.api.getThinkingLevels(activeRuntimeRef.current);
  }, []);

  /** 模型明确标 reasoning:false 时隐藏下拉；列表里查不到就保留（不拿“未知”当“不支持”） */
  const thinkingSupported = useMemo(() => {
    if (!modelKey) return false;
    const cut = modelKey.indexOf("/");
    if (cut <= 0) return false;
    const provider = modelKey.slice(0, cut);
    const id = modelKey.slice(cut + 1);
    const hit = models.find((m) => m.provider === provider && m.id === id);
    return hit ? hit.reasoning !== false : true;
  }, [modelKey, models]);

  async function abort() {
    abortedAt.current = Date.now();
    setBusy(false);
    setStatus("ready");
    await window.api.abort(activeRuntimeRef.current).catch(() => undefined);
  }

  /**
   * 切到一个会话（修改 4 · M0）。
   *
   * 不再走 `switch_session`——那是在**同一个进程里换会话**，pi 会中断在飞的回合，
   * 所以旧代码只能在"不忙"的时候切。现在每个会话有自己的槽：切过去就是把那个槽
   * 叫醒/绑定，别的槽照跑。
   */
  async function loadSession(file: string) {
    if (file === currentFile) return;
    if (currentFile) {
      draftsRef.current[currentFile] = input;
      scrollRef.current[currentFile] = listRef.current?.scrollTop ?? 0;
    }
    let result: SessionOpenView;
    try {
      result = (await window.api.openSession(file)) as SessionOpenView;
    } catch (error) {
      setNotice(`打不开这个会话：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (result?.board) setBoard(result.board);
    if (result?.kind === "queued") {
      setNotice(
        `同时运行的会话已达上限，已排队（第 ${result.position ?? 1} 位）；有空位时会自动打开。`,
      );
      ensureTab(file);
      return;
    }
    ensureTab(file);
    setCurrentFile(file);
    if (result?.slotId) {
      // 复用已有的一整套加载（消息 / 模型 / 统计 / 会话列表），它按 runtimeId 取数
      await activateRuntime(result.slotId);
    } else {
      await refreshSession();
    }
    // 只在有存过的位置时接管滚动，否则让它滚到底
    if (file in scrollRef.current) pendingScroll.current = { file, top: scrollRef.current[file] };
    await refreshSessions();
    setInput(draftsRef.current[file] ?? "");
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
      // 忙也能切走（这正是 M0 要的行为）；先把视图挪到相邻标签
      await loadSession(rest[Math.min(idx, rest.length - 1)]);
    }
    // 关标签才回收：没在跑的会话，槽一起关掉；在跑的就留在后台
    const view = sessionViewFor(file);
    if (!view || !view.busy) {
      try {
        const next = (await window.api.closeSession(file)) as SessionBoardView;
        setBoard(next);
      } catch {
        // 关不掉就留着，下次再关
      }
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

  async function togglePin(file: string, pinned: boolean) {
    const res = await window.api
      .setSessionMeta(file, { pinned })
      .catch(() => ({ ok: false, error: "置顶失败" }));
    if (!res.ok) setNotice(res.error || "置顶失败");
    await refreshSessions();
  }

  /** 行内菜单的克隆/导出/树：必要时先切到目标会话 */
  async function withSession(file: string, fn: () => void | Promise<void>) {
    if (busy) {
      setNotice("正在运行，先停止再操作");
      return;
    }
    if (file !== currentFile) await loadSession(file);
    await fn();
  }

  async function cloneFrom(file: string) {
    await withSession(file, cloneCurrent);
  }

  async function exportFrom(file: string) {
    await withSession(file, exportHtml);
  }

  async function openTree(file: string) {
    await withSession(file, () => {
      setTab("tree");
    });
  }

  async function removeSession(file: string) {
    if (!window.confirm("把这段会话移到 .omcp/trash/sessions？会话文件不会立即删除。")) return;
    const res = await window.api.deleteSession(file).catch(() => ({ ok: false, error: "删除失败" }));
    if (!res.ok) {
      setNotice(res.error || "删除失败");
      return;
    }
    setNotice("已移到回收站");
    await refreshSessions();
    await refreshWorkspaceIndex();
  }

  async function newSession() {
    if (busy) return;
    const ok = await window.api.newSession(activeRuntimeRef.current).catch(() => false);
    if (ok) {
      discardPendingText();
      setMessages([]);
      setStats(null);
      setCurrentFile(null);
      await refreshSessions();
      await refreshState();
    }
  }

  async function cloneCurrent() {
    if (busy) return;
    const r = await window.api.clone(activeRuntimeRef.current).catch(() => ({ cancelled: true }));
    if (!r.cancelled) {
      await refreshSession();
      await refreshSessions();
      setNotice("已克隆当前分支");
    }
  }

  async function forkFrom(entryId: string) {
    if (busy) return;
    if (!confirm("从这条消息创建分支？当前会话会切换到这个分支。")) return;
    const r: ForkResult = await window.api.fork(entryId, activeRuntimeRef.current).catch(() => ({ cancelled: true }));
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

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      const accepted: Array<{ id: string; data: string; mimeType: string; size: number }> = [];
      let skipped = 0;
      for (const file of images) {
        if (file.size > UPLOAD_IMAGE_MAX_BYTES) {
          skipped += 1;
          continue;
        }
        if (accepted.length >= UPLOAD_IMAGE_MAX_COUNT) {
          skipped += 1;
          continue;
        }
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        accepted.push({
          id: `${file.name}-${Date.now()}-${accepted.length}`,
          data: btoa(binary),
          mimeType: file.type || "image/png",
          size: file.size,
        });
      }

      let total = attachments.reduce(
        (sum, a) => sum + Math.ceil((a.data.length * 3) / 4),
        0,
      );
      const out = [...attachments];
      for (const item of accepted) {
        if (out.length >= UPLOAD_IMAGE_MAX_COUNT) {
          skipped += 1;
          continue;
        }
        if (total + item.size > UPLOAD_IMAGE_TOTAL_BYTES) {
          skipped += 1;
          continue;
        }
        out.push({ id: item.id, data: item.data, mimeType: item.mimeType });
        total += item.size;
      }
      setAttachments(out);
      if (skipped > 0) {
        setNotice(
          `已忽略 ${skipped} 张图片（最多 ${UPLOAD_IMAGE_MAX_COUNT} 张，单张 ≤4 MB，总计 ≤12 MB）`,
        );
      }
    },
    [attachments],
  );

  /** 图片对话框选中的项：data 已由主进程读好 */
  function addPickedImages(picked: PickedUpload[]) {
    let total = attachments.reduce(
      (sum, a) => sum + Math.ceil((a.data.length * 3) / 4),
      0,
    );
    const out = [...attachments];
    let skipped = 0;
    for (const f of picked) {
      if (!f.data) continue;
      if (out.length >= UPLOAD_IMAGE_MAX_COUNT) {
        skipped += 1;
        continue;
      }
      if (f.size > UPLOAD_IMAGE_MAX_BYTES) {
        skipped += 1;
        continue;
      }
      if (total + f.size > UPLOAD_IMAGE_TOTAL_BYTES) {
        skipped += 1;
        continue;
      }
      out.push({
        id: `pick-${Date.now()}-${out.length}`,
        data: f.data,
        mimeType: f.mimeType ?? "image/png",
      });
      total += f.size;
    }
    setAttachments(out);
    if (skipped > 0) {
      setNotice(
        `已忽略 ${skipped} 张图片（最多 ${UPLOAD_IMAGE_MAX_COUNT} 张，单张 ≤4 MB，总计 ≤12 MB）`,
      );
    }
  }

  /** 在光标处插入 @ 引用；路径不能含空白（外部/含空格文件已复制为安全名） */
  function insertReferences(paths: string[]) {
    const clean = [...new Set(paths.filter(Boolean))].filter(
      (p) => !input.includes(`@${p}`),
    );
    if (clean.length === 0) {
      setNotice("已在输入框中");
      return;
    }
    setInput((prev) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? prev.length;
      const before = prev.slice(0, caret);
      const pad = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const text = clean.map((p) => `@${p} `).join("");
      const next = before + pad + text + prev.slice(caret);
      requestAnimationFrame(() => {
        const pos = (before + pad + text).length;
        el?.focus();
        el?.setSelectionRange(pos, pos);
      });
      return next;
    });
    setNotice(`已引用 ${clean.length} 个文件`);
  }

  /** 外部/含空格文件：复制到 .omcp/uploads，成功后插入引用 */
  async function importPaths(paths: string[], totalBytes = 0) {
    if (paths.length === 0) return;
    if (
      totalBytes > 1024 * 1024 * 1024 &&
      !window.confirm(
        `将复制约 ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GB，可能需要较长时间。继续？`,
      )
    ) {
      return;
    }
    const importId = `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const name =
      paths.length === 1
        ? paths[0].split(String.fromCharCode(92)).join("/").split("/").pop() || "文件"
        : `${paths.length} 个文件`;
    setUploading({ id: importId, name, percent: 0 });
    try {
      const res = await window.api.importUploads(paths, importId);
      if (res.files.length > 0) insertReferences(res.files);
      if (!res.ok) setNotice(res.error ?? "部分文件上传失败");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "上传失败");
    } finally {
      setUploading(null);
    }
  }

  async function pickUpload(kind: UploadKind) {
    if (!workspace) {
      setNotice("先打开工作区");
      return;
    }
    let res;
    try {
      res = await window.api.pickUpload(kind);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "打开文件对话框失败");
      return;
    }
    if (res.canceled) return;
    if (res.rejected && res.rejected.length > 0) {
      setNotice(
        `未上传：${res.rejected
          .map((r) => (r.name ? `${r.name}（${r.reason}）` : r.reason))
          .join("；")}`,
      );
    }
    if (kind === "image") {
      addPickedImages(res.files);
      return;
    }
    const inside = res.files.filter(
      (f) => f.insideWorkspace && f.relative && !/\s/.test(f.relative),
    );
    if (inside.length > 0) insertReferences(inside.map((f) => f.relative!));
    const insidePaths = new Set(inside.map((f) => f.path));
    const external = res.files.filter((f) => !insidePaths.has(f.path));
    if (external.length > 0) {
      await importPaths(
        external.map((f) => f.path),
        external.reduce((sum, f) => sum + f.size, 0),
      );
    }
  }

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
    // 运行中：Enter 排队，Ctrl/Cmd+Enter 立刻转向（修改 2）
    const redirect = e.ctrlKey || e.metaKey;
    void send(busy ? (redirect ? "steer" : "followUp") : "prompt");
  }

  const setDockTab = (tab: DockTab) => {
    setUi((cur) => (cur.dockTab === tab ? cur : { ...cur, dockTab: tab }));
    saveUiState({ dockTab: tab });
  };

  const toggleDock = () =>
    setDockOpen((open) => {
      const next = !open;
      saveUiState({ dockOpen: next });
      return next;
    });

  /** 会话列表的可见集合：搜索 + 归档过滤 + 按更新时间倒序（PR3） */
  const archivedCount = Object.values(sessionMeta).filter((e) => e.archived === true).length;

  const visibleSessions = sessions
    .filter((s) => {
      const entry = sessionMeta[sessionFileKey(s.sessionFile)];
      // 已归档视图只看归档；主列表看未归档（当前会话即使归档也保留，避免“打开着却消失”）
      if (showArchived) return entry?.archived === true;
      return !entry?.archived || s.sessionFile === currentFile;
    })
    .filter((s) => {
      const q = sessionQuery.trim().toLowerCase();
      if (!q) return true;
      const title = sessionMeta[sessionFileKey(s.sessionFile)]?.title ?? "";
      return `${title} ${s.sessionId} ${s.sessionFile}`.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const pa = sessionMeta[sessionFileKey(a.sessionFile)]?.pinned ? 1 : 0;
      const pb = sessionMeta[sessionFileKey(b.sessionFile)]?.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
    });

  const recentWorkspaces = workspaceIndex.filter((e) => {
    if (e.root === workspace?.root) return false;
    const q = sessionQuery.trim().toLowerCase();
    if (!q) return true;
    return `${workspaceLabel(e.root)} ${e.root}`.toLowerCase().includes(q);
  });

  /** 修改3：关闭右坞后焦点回到顶栏「面板」开关 */
  const closeDock = () => {
    setDockOpen(false);
    saveUiState({ dockOpen: false });
    requestAnimationFrame(() => dockSwitchRef.current?.focus());
  };

  /** 快捷键：Ctrl+J 右坞 / Ctrl+Alt+1..4 右坞面板（Ctrl+1..4、Ctrl+B 空置） */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
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
    window.addEventListener("keydown", onAlt);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onAlt);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      className={`shell${dockOpen ? " dock-open" : ""}`}
      style={{
        ["--side-w" as string]: `${ui.sidebarWidth}px`,
        ["--dock-w" as string]: `${ui.dockWidth}px`,
      }}
    >
      <aside className="sidebar">
        <div className="side-head">
          <strong>oh my coding pi</strong>
          <span className="tag">v{__APP_VERSION__}</span>
        </div>
        <button className="side-new" onClick={() => void newSession()} disabled={busy}>
          ＋ 新建任务
        </button>
        <div className="side-ws-head">
          <span>工作区</span>
          <button className="side-ws-add" onClick={() => void pickWorkspace()} title="切换工作区">
            ＋
          </button>
        </div>
        <input
          className="side-search"
          value={sessionQuery}
          placeholder="搜索工作区 / 会话…"
          spellCheck={false}
          onChange={(e) => setSessionQuery(e.target.value)}
          aria-label="搜索工作区或会话"
        />
        {tab === "sessions" ? (
          <div className="session-list">
            {metaIgnored && (
              <div className="side-empty">标题文件损坏，已忽略。会话列表不受影响。</div>
            )}
            <div className="ws-group open">
              <div className="ws-group-head static">
                <span className="caret">▾</span>
                <span className="ws-name" title={workspace?.root}>
                  {workspaceLabel(workspace?.root)}
                </span>
                <span className="count">{sessions.length}</span>
              </div>
              <div className="ws-sessions">
                {visibleSessions.map((s) => {
                  const key = sessionFileKey(s.sessionFile);
                  const entry = sessionMeta[key];
                  const label = entry?.title || s.sessionId.slice(0, 8);
                  const open = menuFor === s.sessionFile;
                  return (
                    <div
                      key={s.sessionFile}
                      className={`session ${s.sessionFile === currentFile ? "active" : ""} ${
                        entry?.archived ? "archived" : ""
                      } ${entry?.pinned ? "pinned" : ""}`}
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
                          onClick={() => void loadSession(s.sessionFile)}
                          title={entry?.title ? `${entry.title}\n${s.sessionFile}` : s.sessionFile}
                        >
                          <span className="sid">
                            {entry?.pinned ? "★ " : ""}
                            {label}
                          </span>
                          <span className="stamp">{formatRelative(s.updatedAt)}</span>
                        </button>
                      )}
                      <button
                        type="button"
                        className="session-more"
                        aria-label="会话操作"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuFor(open ? null : s.sessionFile);
                        }}
                      >
                        ⋯
                      </button>
                      {open && (
                        <div className="session-menu" role="menu" aria-label={`${label} 的操作`}>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              renameCancelled.current = false;
                              setRenamingFile(s.sessionFile);
                              setRenameValue(entry?.title || "");
                            }}
                          >
                            重命名
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void togglePin(s.sessionFile, !entry?.pinned);
                            }}
                          >
                            {entry?.pinned ? "取消置顶" : "置顶"}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void toggleArchive(s.sessionFile, !entry?.archived);
                            }}
                          >
                            {entry?.archived ? "还原" : "归档"}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void cloneFrom(s.sessionFile);
                            }}
                          >
                            克隆
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void exportFrom(s.sessionFile);
                            }}
                          >
                            导出
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void openTree(s.sessionFile);
                            }}
                          >
                            在树中查看
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenuFor(null);
                              void removeSession(s.sessionFile);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {visibleSessions.length === 0 && (
                  <div className="side-empty">
                    {sessionQuery.trim()
                      ? "没有匹配的会话"
                      : showArchived
                        ? "没有已归档会话"
                        : sessions.length === 0
                          ? "还没有会话"
                          : "没有未归档会话"}
                  </div>
                )}
              </div>
            </div>
            {recentWorkspaces.map((entry) => {
              const expanded = expandedWorkspaces.has(entry.root);
              return (
                <div className={`ws-group ${expanded ? "open" : ""}`} key={entry.root}>
                  <button
                    type="button"
                    className="ws-group-head"
                    onClick={() =>
                      setExpandedWorkspaces((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.root)) next.delete(entry.root);
                        else next.add(entry.root);
                        saveUiState({ expandedWorkspaces: [...next] });
                        return next;
                      })
                    }
                  >
                    <span className="caret">{expanded ? "▾" : "▸"}</span>
                    <span className="ws-name" title={entry.root}>
                      {workspaceLabel(entry.root)}
                    </span>
                    <span className="count">{entry.sessionCount}</span>
                  </button>
                  {expanded && (
                    <div className="ws-sessions">
                      <button
                        type="button"
                        className="ws-switch"
                        onClick={() => void openWorkspacePath(entry.root)}
                      >
                        切换到此工作区
                      </button>
                      <div className="ws-hint">
                        {entry.updatedAt ? `最近 ${formatRelative(entry.updatedAt)}` : "切换后加载会话"}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="tree-panel">
            <button type="button" className="tree-back" onClick={() => setTab("sessions")}>
              ← 返回会话
            </button>
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
          <button
            type="button"
            className={showArchived ? "active" : ""}
            onClick={() => setShowArchived((v) => !v)}
            title="只看已归档会话"
          >
            已归档 {archivedCount}
          </button>
          <button type="button" onClick={() => setOverlay("permissions")}>权限</button>
          <button type="button" onClick={() => setOverlay("skills")}>技能</button>
          <button type="button" onClick={() => setOverlay("settings")}>设置</button>
        </div>
      </aside>

      <Sash
        side="left"
        width={ui.sidebarWidth}
        min={UI_LIMITS.sidebar.min}
        max={UI_LIMITS.sidebar.max}
        label="调整侧栏宽度"
        onChange={(next) => setUi((cur) => ({ ...cur, sidebarWidth: clampWidth("sidebar", next) }))}
        onCommit={(next) => saveUiState({ sidebarWidth: clampWidth("sidebar", next) })}
      />

        <header className="bar">
          <div className="bar-right">
            <PermissionPill />
            <ContextMeter sessionKey={currentFile} busy={busy} />
            <span className="model-group">
              <ModelPicker
                models={models}
                value={modelKey}
                disabled={busy}
                onPick={changeModel}
                triggerRef={modelSelectRef}
              />
              {thinkingSupported && (
                <ThinkingPicker
                  level={thinkingLevel}
                  disabled={busy}
                  onOpenLevels={loadThinkingLevels}
                  onPick={changeThinkingLevel}
                />
              )}
            </span>
            <span className={`status ${status}`}>{status}</span>
            {busy && (
              <button className="abort" onClick={abort}>
                停止
              </button>
            )}
          </div>
          <div className="bar-fixed">
            <button
              ref={dockSwitchRef}
              className="dock-toggle dock-switch"
              onClick={toggleDock}
              aria-expanded={dockOpen}
              aria-controls="right-dock"
              title="显示或收起右侧工作坞（Ctrl+J）"
            >
              {dockOpen ? `面板：${DOCK_LABEL[ui.dockTab]}` : "面板"}
            </button>
          </div>
        </header>

      <div className="main">
        <div className="top">

        {openTabs.length > 0 && (
          <div className="session-tabs" role="tablist" aria-label="已打开的会话">
            {openTabs.map((file) => {
              const active = file === currentFile;
              const label = tabLabel(file);
              const info = sessionViewFor(file);
              const running = info?.running ?? false;
              const tabBusy = info?.busy ?? false;
              const unread = info?.unread ?? 0;
              return (
                <div
                  key={file}
                  className={`session-tab ${active ? "active" : ""} ${running ? "" : "suspended"}`}
                >
                  <button
                    type="button"
                    className="tab-label"
                    role="tab"
                    aria-selected={active}
                    title={[
                      file,
                      tabBusy ? "运行中" : running ? "空闲" : "已挂起（切回会自动恢复）",
                    ].join(" · ")}
                    onClick={() => void loadSession(file)}
                  >
                    <span
                      className="tab-dot"
                      data-busy={tabBusy ? "1" : undefined}
                      data-suspended={running ? undefined : "1"}
                    />
                    {label}
                    {unread > 0 && <span className="tab-unread">{unread}</span>}
                  </button>
                  <button
                    type="button"
                    className="tab-close"
                    aria-label={`关闭页签 ${label}`}
                    disabled={openTabs.length === 1}
                    title={openTabs.length === 1 ? "至少保留一个页签" : "关闭页签，不删除会话文件"}
                    onClick={() => void closeTab(file)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {board && (
              <span className="session-count">
                {board.slots.filter((item) => item.running).length} 运行 / {openTabs.length} 标签
              </span>
            )}
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
          <ErrorBanner
            view={presentModelError(modelError)}
            actions={
              <button
                type="button"
                onClick={() => {
                  modelSelectRef.current?.focus();
                  setNotice("在上方模型选择器里换一个模型");
                }}
              >
                换个模型
              </button>
            }
            onClose={() => setModelError(null)}
          />
        )}
        {policy?.mode === "readonly" && <ReadonlyBanner />}
        {notice && <div className="notice">{notice}</div>}
        {appError && (
          <ErrorBanner
            view={presentAppError(appError)}
            actions={
              <>
                {appError.action === "restart-pi" && (
                  <button type="button" onClick={restartPi}>
                    重启 pi
                  </button>
                )}
                {appError.action === "open-settings" && (
                  <button type="button" onClick={() => setOverlay("settings")}>
                    设置
                  </button>
                )}
                {appError.action === "retry" && (
                  <button
                    type="button"
                    onClick={() => {
                      modelSelectRef.current?.focus();
                      setNotice("已停止自动重试；可以换个模型，或稍后再发一次");
                    }}
                  >
                    换个模型
                  </button>
                )}
              </>
            }
            onClose={() => setAppError(null)}
          />
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
                <div className="msg user" key={m.id ?? i}>
                  <div className="bubble">
                    {m.attachments?.length ? (
                      <div className="msg-attachments">
                        {m.attachments.map((img) => (
                          <button
                            key={img.id}
                            type="button"
                            className="msg-image"
                            title="查看大图"
                            onClick={() => setImagePreview(img)}
                          >
                            <img src={`data:${img.mimeType};base64,${img.data}`} alt="图片" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {m.text}
                    {m.failed && (
                      <span className="msg-failed" title="这条消息没有被 pi 接受">
                        未送达
                      </span>
                    )}
                  </div>
                  {m.textOnly && (
                    <div className="msg-hint">当前模型仅文本：图片会先转述再发送</div>
                  )}
                </div>
              );
            }
            if (m.kind === "assistant") {
              return (
                <div className="msg assistant" key={m.id ?? i}>
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
                  key={m.id ?? i}
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
          {!slotReady && (
            <div className="submit-state" role="status">
              <span className="submit-dot" aria-hidden="true" />
              <span>这个会话的 pi 正在启动…（首次启动可能需要几十秒）</span>
            </div>
          )}
          {slotReady && (submitPhase === "submitting" || submitPhase === "accepted" || submitPhase === "preparing") && (
            <div className="submit-state" role="status">
              <span className="submit-dot" aria-hidden="true" />
              <span>{SUBMIT_LABEL[submitPhase]}</span>
              <button
                type="button"
                className="mini"
                onClick={() => {
                  abortedAt.current = Date.now();
                  void window.api.abort(activeRuntimeRef.current);
                }}
              >
                停止
              </button>
            </div>
          )}
          <QueueBar
            queue={queue}
            onTakeBack={() => void takeBackQueue(true)}
            onRedirect={(i) => void redirectQueued(i)}
            onNewSession={(i) => void queueToNewSession(i)}
          />
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
          {uploading && (
            <div className="upload-progress" role="status">
              <span>
                正在复制 {uploading.name} · {uploading.percent}%
              </span>
              <button
                type="button"
                onClick={() => {
                  void window.api.cancelUpload(uploading.id);
                }}
              >
                取消
              </button>
            </div>
          )}
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
            <UploadMenu onPick={(kind) => void pickUpload(kind)} disabled={!workspace} />
            <textarea
              ref={textareaRef}
              value={input}
              placeholder={
                busy
                  ? "pi 正在工作；Enter 插入，Shift+Enter 换行"
                  : "输入消息，Enter 发送；可粘贴图片，＋ 上传文件，@ 补全路径"
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
                const files = Array.from(e.dataTransfer.files ?? []);
                const images = files.filter((f) => f.type.startsWith("image/"));
                const others = files.filter((f) => !f.type.startsWith("image/"));
                if (images.length > 0) void addImageFiles(images);
                if (others.length > 0) {
                  const paths: string[] = [];
                  for (const file of others) {
                    try {
                      const path = window.api.pathForFile(file);
                      if (path) paths.push(path);
                    } catch {
                      // 浏览器没有路径：下面统一提示
                    }
                  }
                  if (paths.length > 0) void importPaths(paths);
                  else setNotice("无法读取拖拽文件的路径");
                }
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
              <button onClick={() => send("followUp")} disabled={!input.trim()}>
                排队
              </button>
              <button className="secondary" onClick={() => send("followUp")} disabled={!input.trim()}>
                追加
              </button>
            </div>
          ) : (
            <button
              onClick={() => send("prompt")}
              disabled={!input.trim() || submitPhase !== "idle" || !slotReady}
              title={!slotReady ? "这个会话的 pi 正在启动" : submitPhase !== "idle" ? SUBMIT_LABEL[submitPhase] : undefined}
            >
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
        onClose={closeDock}
        onResetWidth={() => {
          setUi((cur) => ({ ...cur, dockWidth: 320 }));
          saveUiState({ dockWidth: 320 });
        }}
        files={(
          <div className="dock-files">
            {previewLoading && <div className="dock-empty">读取文件…</div>}
            {workspace?.root ? (
              <FileTree
                rootName={workspaceLabel(workspace.root)}
                expanded={expandedDirs}
                selected={selectedPath}
                onToggle={toggleDir}
                onSelect={openFromTree}
                load={loadTreeDir}
              />
            ) : (
              <div className="dock-empty">没有打开工作区</div>
            )}
            {preview && (
              <div className="dock-preview">
                <div className="preview-head">
                  <button
                    onClick={() => {
                      setPreview(null);
                      setFileInfo(null);
                      setSelectedPath(null);
                    }}
                    title="关闭预览"
                  >
                    ×
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
              </div>
            )}
            <div className="dock-note">只读。不列 .git、node_modules、.omcp。</div>
          </div>
        )}
        artifacts={(
          <ArtifactsPane
            active={dockOpen && ui.dockTab === "artifacts"}
            onReveal={revealInTree}
          />
        )}
        run={(
              <div className="dock-run">
                <div className="kernel-line">
                  <LangBadge lang="python" /> Python 内核
                </div>
                <div className="kernel-line">
                  <LangBadge lang="r" /> R 内核
                </div>
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
              {overlay === "settings" && <Settings theme={theme} onThemeChange={setTheme} />}
            </div>
          </div>
        </div>
      )}
      {approval && (
        <ApprovalModal
          request={approval}
          onRespond={respondApproval}
          runtimeLabel={runtimeLabel(approval.runtimeId)}
        />
      )}

      {imagePreview && (
        <div
          className="msg-image-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setImagePreview(null)}
        >
          <button
            className="msg-image-close"
            type="button"
            onClick={() => setImagePreview(null)}
            title="关闭"
          >
            ✕
          </button>
          <img
            src={`data:${imagePreview.mimeType};base64,${imagePreview.data}`}
            alt="图片预览"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
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
