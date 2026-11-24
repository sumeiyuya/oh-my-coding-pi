/**
 * oh-my-coding-pi v1 协议契约（P0 冻结）
 *
 * 这是 UI ↔ 主进程 ↔ pi ↔ 内核 的唯一类型来源。
 * P1 起只允许“新增可选字段/新增联合分支”，不允许修改已有字段语义。
 * 修改必须同步 docs/scope.md 与 docs/decisions.md。
 */

export const PROTOCOL_VERSION = 1 as const;

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

export type SessionFile = string; // 绝对路径
export type SessionId = string;
export type EntryId = string;
export type ToolCallId = string;

export type BridgeStatus = "starting" | "restarting" | "ready" | "busy" | "error" | "stopped";

export interface ImageAttachment {
  type: "image";
  /** base64，不带 data: 前缀 */
  data: string;
  mimeType: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "thinking"; thinking: string };

export type MessageContent = string | ContentBlock[];

export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost?: UsageCost;
}

export type MessageRole = "system" | "user" | "assistant" | "toolResult";

export interface ToolCall {
  id: ToolCallId;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
}

export interface AgentMessage {
  role: MessageRole;
  content: MessageContent;
  timestamp?: number;
  usage?: Usage;
  stopReason?: string;
  toolCallId?: ToolCallId;
  toolName?: string;
  isError?: boolean;
  /** provider 私有字段（api/provider/model 等） */
  [key: string]: unknown;
  /** 模型报错时 pi 会把原因写在这里 */
  errorMessage?: string;
}

/* ------------------------------------------------------------------ */
/* pi RPC：命令                                                        */
/* ------------------------------------------------------------------ */

export type PiCommand =
  | {
      type: "prompt";
      message: string;
      images?: ImageAttachment[];
      streamingBehavior?: "steer" | "followUp";
    }
  | { type: "steer"; message: string; images?: ImageAttachment[] }
  | { type: "follow_up"; message: string; images?: ImageAttachment[] }
  | { type: "abort" }
  | { type: "clear_queue" }
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_entries"; since?: EntryId }
  | { type: "get_tree" }
  | { type: "get_session_stats" }
  | { type: "get_fork_messages" }
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  | { type: "get_available_thinking_levels" }
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "compact"; customInstructions?: string }
  | { type: "switch_session"; sessionPath: SessionFile }
  | { type: "new_session"; parentSession?: SessionFile }
  | { type: "fork"; entryId: EntryId }
  | { type: "clone" }
  | { type: "set_session_name"; name: string }
  | { type: "export_html"; outputPath?: string };

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** 运行期校验用：主进程收 IPC 时先过一遍，不把任意字符串转给 pi */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

export type PiRequestEnvelope = PiCommand & { id: string };

export interface PiResponse {
  type: "response";
  id: string;
  command: PiCommand["type"];
  success: boolean;
  data?: unknown;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* pi RPC：事件                                                        */
/* ------------------------------------------------------------------ */

export type AssistantMessageEvent =
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_start"; contentIndex: number; id: ToolCallId; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall };

export type ExtensionUIRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    };

export type ExtensionUIResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: ToolCallId;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_execution_update";
      toolCallId: ToolCallId;
      toolName: string;
      args: Record<string, unknown>;
      partialResult: ToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: ToolCallId;
      toolName: string;
      result: ToolResult;
      isError: boolean;
    }
  | ExtensionUIRequest
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  | { type: "extension_error"; message: string; stack?: string }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "queue_update"; steering: string[]; followUp: string[] };

export type PiStreamItem = PiEvent | PiResponse;

/* ------------------------------------------------------------------ */
/* 回合时序（主进程 → renderer）：只描述阶段，不携带正文                */
/* ------------------------------------------------------------------ */

export type TurnPhase =
  | "accepted"
  | "preparing"
  | "started"
  | "first_token"
  | "tool_start"
  | "tool_end"
  | "settled"
  | "failed";

export interface TurnPhaseDetail {
  tool?: string;
  ok?: boolean;
  reason?: string;
  ms?: number;
}

export interface TurnPhaseEvent {
  turnId: string;
  phase: TurnPhase;
  /** 墙钟时间，仅用于展示 */
  at: number;
  /** 相对 accepted 的毫秒数 */
  elapsedMs: number;
  detail?: TurnPhaseDetail;
}

/* ------------------------------------------------------------------ */
/* 上传（修改1）：文件 / 图片 / 数据                                    */
/* ------------------------------------------------------------------ */

export type UploadKind = "file" | "image" | "data";

/** 图片的安全上限：base64 传输与模型输入的内存约束，不是产品限额 */
export const UPLOAD_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const UPLOAD_IMAGE_MAX_COUNT = 4;
export const UPLOAD_IMAGE_TOTAL_BYTES = 12 * 1024 * 1024;

export interface PickedUpload {
  /** 本机绝对路径 */
  path: string;
  name: string;
  size: number;
  /** 是否在当前工作区内 */
  insideWorkspace: boolean;
  /** 工作区相对路径（统一 / 分隔）；不在工作区内时缺省 */
  relative?: string;
  /** 图片才有：base64 与 mime */
  data?: string;
  mimeType?: string;
}

export interface PickUploadResult {
  canceled: boolean;
  files: PickedUpload[];
  /** 被拒绝的项与原因（图片过大/不可读/重复） */
  rejected?: Array<{ name: string; reason: string }>;
}

export interface UploadProgress {
  importId: string;
  file: string;
  copiedBytes: number;
  totalBytes: number;
}

/* ------------------------------------------------------------------ */
/* 审批                                                                */
/* ------------------------------------------------------------------ */

export type ApprovalScope = "once" | "session" | "always" | "deny" | "timeout";

export interface ApprovalOption {
  value: ApprovalScope;
  label: string;
}

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { value: "once", label: "仅本次" },
  { value: "session", label: "本会话" },
  { value: "always", label: "总是允许" },
  { value: "deny", label: "拒绝" },
] as const;

export const APPROVAL_TITLE_PREFIX = "omcp-approval:" as const;

export interface ApprovalTitlePayload {
  v: 1;
  toolName: string;
  ruleId: string;
  summary: string;
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  /** P1b2c2：审批来自哪个 runtime；旧路径没有这个字段 */
  runtimeId?: string;
  /** 命中的规则 id，例如 rm-rf；授权按它记录 */
  ruleId: string;
  /** 原始命令或操作摘要 */
  summary: string;
  options: ApprovalOption[];
  timeoutMs: number;
  requestedAt: string;
}

export interface ApprovalDecision {
  requestId: string;
  scope: ApprovalScope;
  decidedAt: string;
}

export interface PolicyInfo {
  mode: PolicyMode;
  source: "workspace" | "settings" | "default";
  path: string | null;
  errors: string[];
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  tool?: string;
  decision?: "allow" | "deny" | "timeout" | "";
  /** 摘要/规则 id 的子串匹配 */
  q?: string;
}

export interface AuditPage {
  total: number;
  items: AuditEntryView[];
}

export type RouteStatus = "todo" | "doing" | "done" | "blocked";
export type RouteEvidence = "none" | "limited" | "strong";

export interface RouteStep {
  id: string;
  title: string;
  purpose: string;
  inputs: string;
  outputs: string;
  status: RouteStatus;
  evidence: RouteEvidence;
}

export interface RouteDoc {
  version: 1;
  updatedAt: string;
  steps: RouteStep[];
}

export interface RouteLoadResult {
  doc: RouteDoc;
  errors: string[];
  exists: boolean;
}

export interface PlanGateStatus {
  enabled: boolean;
  approved: boolean;
  planPath: string | null;
  /** 批准时记录的计划内容摘要（sha256）；未批准或旧状态为 null */
  digest: string | null;
}

export interface ModelPreflightView {
  ok: boolean;
  reason: "ok" | "no_credential" | "bad_url" | "model_not_found" | "unknown_provider";
  message: string;
  fix?: "add_key" | "confirm_connection" | "choose_model";
  baseUrl?: string;
  credentialSource: "stored" | "env" | "auth" | "none";
}

export interface ModelSetupModel {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelSetupInfo {
  provider: string;
  /** pi 的内置目录是否认识这个 provider */
  known: boolean;
  catalog: { baseUrl: string; api: string; requiresBaseUrl: boolean } | null;
  config: { baseUrl: string; api?: string; local?: boolean; models: ModelSetupModel[] } | null;
  credential: { source: "stored" | "env" | "auth" | "none"; has: boolean };
  /** 会为它注入的环境变量名（内置 provider 是官方名 + OMCP_KEY_<ID>） */
  envKeys: string[];
  models: ModelSetupModel[];
  /** 将写入 models.json 的片段（apiKey 是 $ 引用） */
  preview: Record<string, unknown>;
}

export interface ModelSetupInput {
  provider: string;
  baseUrl: string;
  api?: string;
  modelIds: string[];
  /** 留空表示不修改已有密钥 */
  apiKey?: string;
}

export interface ModelSetupResult {
  ok: boolean;
  errors?: string[];
  warnings?: string[];
  written?: boolean;
  restarted?: boolean;
  credential?: "stored" | "env" | "auth" | "none";
  preview?: Record<string, unknown>;
}

export interface PiRuntimeInfo {
  origin: "env" | "bundled" | "path" | "error";
  entry: string;
  expected: string | null;
  actual: string | null;
  ok: boolean;
  configDir: string;
  configIsolated: boolean;
  /** 勾选“独立配置目录”时应使用的路径 */
  defaultIsolatedDir: string;
  system: { path: string | null; version: string | null };
}

export interface VisionSettingsView {
  /** 是否已解析到可用的视觉端点 */
  enabled: boolean;
  /** registry = 注册表里的 vision；legacy = 旧的独立三项配置；none = 未配置 */
  source: "registry" | "legacy" | "none";
  provider: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** 系统是否支持安全存储（false 时不允许保存 key） */
  supported: boolean;
}

export interface DescribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  /** 相对工作区，例如 .agents/skills/desc-stats/SKILL.md */
  path: string;
  enabled: boolean;
  /** 校验问题；空数组表示可用 */
  errors: string[];
}

export interface UpdateCheckResult {
  /** 是否配置了更新源（settings.updateRepo） */
  configured: boolean;
  current: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  notes?: string;
  publishedAt?: string;
  /** 发布页的 SHA256 资产内容（若提供） */
  sha256?: string | null;
  /** 失败分类。UI 据此给不同提示，不去解析 error 文本。 */
  errorKind?: UpdateErrorKind;
  error?: string;
}

/**
 * 更新检查失败的类型：
 * - auth：401/403，仓库不可访问（私有仓或被限流至无权限）
 * - not_found：404，仓库或 release 不存在
 * - ratelimit：429，请求过于频繁
 * - timeout：请求超时
 * - network：其他网络/服务端错误（含 5xx）
 * - parse：返回体不是有效 JSON 或缺少 tag_name
 */
export type UpdateErrorKind = "auth" | "not_found" | "ratelimit" | "timeout" | "network" | "parse";

export interface AppSettingsDetail {
  provider: string;
  model: string;
  sessionLimit: number;
  dailyLimit: number;
  policyPath: string;
  /** 空 = 自动探测（工作区 .venv → 系统 python） */
  pythonPath: string;
  /** R 解释器路径；空 = 沿用机器上的 sci-ir kernelspec */
  rPath: string;
  /** GitHub "owner/repo"；空 = 未配置更新源 */
  updateRepo: string;
  /** 是否信任项目级资源（.pi 设置、项目扩展、.agents/skills） */
  trustProject: boolean;
  /** 空 = 共享 ~/.pi/agent；非空 = 独立配置目录（需要重新登录） */
  piConfigDir: string;
  grantTtlDays: number;
  readonlyNotebook: boolean;
  /** 三档权限；会话可单独覆盖（见 SessionMetaEntry.permissionMode） */
  permissionMode: PermissionMode;
  /** 推理强度默认档：新会话/重启 pi 时沿用 */
  thinkingLevel: ThinkingLevel;
  /** P3c：最多同时保留几个 runtime（默认 2） */
  maxRuntimes: number;
  /** P3c：后台 runtime 空闲多少分钟后停 pi（默认 30） */
  runtimeIdleMinutes: number;
}

/** 切模型的结果：失败时带上 pi 的原文，界面不能假装换过了。 */
export interface SetModelResult {
  ok: boolean;
  error?: string;
}

/** prompt / steer / follow_up 的结果：pi 拒绝时把原文带回来，不再只给一个布尔 */
export interface PromptResult {
  ok: boolean;
  /** pi 返回的拒绝原因（原文），例如 "No API key found for deepseek" */
  error?: string;
}

/** 顶栏权限 pill 读到的三档状态（照 DAWN 的「这一段 / 跟随默认」） */
export interface PermissionState {
  /** 实际生效的档（会话覆盖 > 应用默认） */
  effective: PermissionMode;
  /** 这一段单独设过的档；null = 跟随默认 */
  sessionOverride: PermissionMode | null;
  /** 应用默认 */
  default: PermissionMode;
}

export interface AppSettingsView {
  /** 0 = 永久 */
  grantTtlDays: number;
  /** 只读模式下是否允许执行笔记本 cell */
  readonlyNotebook: boolean;
  /** 三档权限；会话可单独覆盖（见 SessionMetaEntry.permissionMode） */
  permissionMode: PermissionMode;
}

/** 插件视图（ADR-045）：插件册的主进程投影，渲染进程只读。 */
export interface PluginToolView {
  name: string;
  label: string;
  description: string;
  /** false = 本批尚未实现（不会注册给 pi） */
  ready?: boolean;
}

export interface PluginFamilyView {
  key: string;
  name: string;
  /** 该族当前是否开启（整包关闭时为 false） */
  on: boolean;
  tools: PluginToolView[];
}

export interface PluginView {
  id: string;
  name: string;
  key: string;
  /** 整包开关 */
  on: boolean;
  families: PluginFamilyView[];
}

export interface PluginsResult {
  plugins: PluginView[];
  /** 下发给 pi 扩展的族键（= 真正会注册的工具族） */
  enabledKeys: string[];
}

/* ------------------------------------------------------------------ */
/* MCP（P1）：配置视图；值永远不进视图，只给名字                          */
/* ------------------------------------------------------------------ */

export type McpExposure = "direct" | "deferred" | "codemode" | "hidden";
export type McpTransport = "stdio" | "http";

/** unchecked = 还没试过；checking = 检查子进程在跑；failed 必须带 error */
export type McpState =
  | "unchecked"
  | "checking"
  | "ready"
  | "failed"
  | "needs-auth"
  | "disabled";

export interface McpToolView {
  name: string;
  description?: string;
  readOnly?: boolean;
}

export interface McpServerView {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  cwd?: string;
  /** 需要的环境变量名 / 请求头名；值不在视图里 */
  secrets: string[];
  /** 还没填的那些（SecretStore 与进程 env 都没有） */
  missingSecrets: string[];
  enabled: boolean;
  exposure: McpExposure;
  description?: string;
  from: "global" | "project";
  /** command/args 或 url 的短指纹；信任跟着它走 */
  fingerprint: string;
  trusted: boolean;
  state: McpState;
  error?: string;
  tools: McpToolView[];
}

export interface McpListView {
  configPath: string;
  servers: McpServerView[];
  /** 配置本身的问题（重名、JSON 坏、字段非法）；不静默跳过 */
  problems: string[];
  /** pi 的原话：项目未信任时说明 .pi/mcp.json 被忽略 */
  note?: string;
}

export interface McpSaveResult {
  name: string;
  needsSecrets: string[];
  list: McpListView;
}

export interface RuntimeView {
  id: string;
  active: boolean;
  workspace: string;
  /** P3b：runtime 是否还在跑（空闲回收后会停） */
  running: boolean;
  /** P3b：是否正在跑一轮 */
  busy: boolean;
}

/**
 * 修改 4 · M0：会话是界面上的身份，槽是背后的 pi 进程。
 *
 * 这两张表一起给界面用：会话标签显示「哪段对话 + 它的进程在不在跑」，
 * 槽表只在诊断面板出现。`state` 与槽无关——挂起（suspended）是"保留但不占资源"，
 * interrupted 是"进程崩了，这一轮被打断"，两者不能混。
 */
export type SessionRunState = "closed" | "suspended" | "idle" | "busy" | "interrupted";

export interface SessionView {
  /** 规范化后的绝对路径（主键） */
  key: string;
  file: string;
  workspace: string;
  title?: string;
  state: SessionRunState;
  unread: number;
  slotId: string | null;
  running: boolean;
  busy: boolean;
  active: boolean;
  /** 修改 4 · M3：在等名额时的位次（1 = 下一个） */
  queued?: number;
}

export interface SlotView {
  id: string;
  workspace: string;
  sessionFile: string | null;
  state: "free" | "starting" | "idle" | "busy" | "suspended";
  running: boolean;
  ready: boolean;
  busy: boolean;
  active: boolean;
}

export interface SessionBoardView {
  sessions: SessionView[];
  slots: SlotView[];
  activeSlotId: string | null;
  maxSlots: number;
}

export interface SessionOpenView {
  kind: "activated" | "bound" | "resumed" | "created" | "preempted" | "queued";
  slotId?: string;
  position?: number;
  board: SessionBoardView;
}

export interface McpLoginResult {
  ok: boolean;
  /** 授权页地址：浏览器没自动打开时给用户点 */
  url?: string;
  error?: string;
}


/** 记忆条目（ADR-046）：存 <userData>/memory/*.jsonl，不落工作区。 */
export interface MemoryItem {
  id: string;
  ts: string;
  kind: "memory" | "skill";
  target?: "user" | "memory" | "key";
  content?: string;
  reason?: string;
  branches?: string[];
  name?: string;
  description?: string;
  /** 技能提案的 SKILL.md 正文（仅 kind="skill"） */
  body?: string;
  adoptedAt?: string;
}

export interface MemoryQueue {
  pending: MemoryItem[];
  approved: MemoryItem[];
}

export interface AuditEntryView {
  ts: string;
  toolName: string;
  ruleId: string;
  decision: "allow" | "deny" | "timeout";
  scope?: string;
  summary: string;
  sessionId?: string;
  source?: string;
  /** 上传审计：只记路径，不记内容 */
  files?: string[];
}

export interface PersistentGrant {
  id: string;
  /** 工作区绝对路径的哈希，避免跨项目复用 */
  workspaceId: string;
  ruleId: string;
  createdAt: string;
  expiresAt?: string;
}

/* ------------------------------------------------------------------ */
/* 策略（与 policy.schema.json 对应）                                   */
/* ------------------------------------------------------------------ */

/**
 * 三档权限（照 DAWN：deny-risky / ask-risky / allow-all，由低到高）。
 *
 * `ask` / `allow` / `deny` / `readonly` 是 0.5.x 的内部档名，继续保留：
 * 策略文件里可能写着它们，读的时候映射到新档，写回去只用新档。
 */
export type PermissionMode = "deny-risky" | "ask-risky" | "allow-all";

export type PolicyMode = "ask" | "allow" | "deny" | "readonly" | PermissionMode;

/** 旧档名 → 新档（只读不映射：它是另一层语义，不进三档主界面） */
export function toPermissionMode(mode: PolicyMode): PermissionMode | null {
  if (mode === "deny-risky" || mode === "ask-risky" || mode === "allow-all") return mode;
  if (mode === "ask") return "ask-risky";
  if (mode === "allow") return "allow-all";
  return null;
}

export interface PolicyConfig {
  version: 1;
  mode: PolicyMode;
  tools: {
    allow: string[];
    deny: string[];
  };
  paths: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
  };
  commands: {
    deny: string[];
    ask: string[];
  };
  runCode: {
    requireApproval: boolean;
    timeoutSec: number;
    maxOutputChars: number;
  };
  audit: {
    enabled: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* 内核 sidecar                                                        */
/* ------------------------------------------------------------------ */

export type KernelLanguage = "python" | "r";

export type KernelRequest =
  | { op: "start"; lang: KernelLanguage; interpreter?: string }
  | { op: "execute"; id: string; code: string }
  | { op: "interrupt" }
  | { op: "restart" }
  | { op: "shutdown" }
  | { op: "ping" };

export type KernelEvent =
  | { ev: "ready"; kernel: string; pid: number | null; restarted?: boolean }
  | { ev: "stream"; id: string; name: "stdout" | "stderr"; text: string }
  | { ev: "display"; id: string; mime: "image/png"; data: string }
  | { ev: "display"; id: string; mime: "text/plain"; text: string }
  | { ev: "error"; id?: string; ename: string; evalue: string; traceback: string[] }
  | { ev: "result"; id: string; status: "ok" | "error" | "unknown" }
  | { ev: "shutdown"; alive: boolean }
  | { ev: "pong" };

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface KernelHandle {
  execute(code: string, onEvent: (ev: KernelEvent) => void): Promise<void>;
  interrupt(): Promise<void>;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
}

/** v1 只实现 local；wsl/docker 为 v1.1 预留 */
export interface ExecutionBackend {
  readonly id: "local" | "wsl" | "docker";
  exec(
    cmd: string,
    opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ExecResult>;
  toHostPath(path: string): string;
  toBackendPath(path: string): string;
  startKernel(lang: KernelLanguage, cwd: string): Promise<KernelHandle>;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export interface SessionEntry {
  type: string;
  id: EntryId;
  parentId: EntryId | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionState {
  sessionId: SessionId;
  sessionFile: SessionFile;
  sessionName?: string;
  messageCount: number;
  isStreaming: boolean;
  model: { provider: string; id: string } | null;
  /** pi 当前会话实际生效的推理档（模型可能把请求的档钳制过） */
  thinkingLevel?: ThinkingLevel;
}

export interface SessionStats {
  sessionId: SessionId;
  sessionFile: SessionFile;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
    /** 已用 token 的别名（与 DAWN 的 usedTokens 对齐；null = 刚压缩过、还没有新回复） */
    usedTokens?: number | null;
    /**
     * 自动压缩线：可用 token 低于 pi 的 reserveTokens（默认 16384）就开始压缩。
     * 数值按 pi 默认值推算，pi 设置里改过 reserveTokens 时会不准——界面要写「按默认估算」。
     */
    compactAt?: number;
    /** 刚压缩过、还没有 post-compaction 的回复：此时 tokens 不可信 */
    afterCompaction?: boolean;
    /** 数值是否为估算（本应用不按字节估，恒 false；字段保留是为了与 DAWN 的读数规则对齐） */
    estimated?: boolean;
  };
}

export interface SessionSummary {
  sessionId: SessionId;
  sessionFile: SessionFile;
  name?: string;
  updatedAt?: string;
  messageCount?: number;
  cost?: number;
}

/** 旁路元数据。不写进 pi 的 jsonl。键是会话文件名，不是绝对路径。 */
export interface SessionMetaEntry {
  title?: string;
  /** 用户手动改过名：自动标题不再覆盖（R5） */
  renamed?: boolean;
  archived?: boolean;
  /** 修改2：置顶；置顶会话排在组内最前 */
  pinned?: boolean;
  lastOpenedAt?: string;
  /** 这一段会话自己的权限档；缺省 = 跟随应用默认 */
  permissionMode?: PermissionMode;
}

export interface SessionMetaResult {
  version: 1;
  sessions: Record<string, SessionMetaEntry>;
  /** 文件损坏时为 true。会话列表不依赖这份文件。 */
  ignored?: boolean;
}

export interface SessionMetaPatch {
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  permissionMode?: PermissionMode | null;
}

/** 修改2：最近工作区的会话数/更新时间（只读目录，不解析 JSONL） */
export interface WorkspaceIndexEntry {
  root: string;
  sessionCount: number;
  updatedAt?: string;
}

/* ------------------------------------------------------------------ */
/* 工作区文件（只读）                                                  */
/* ------------------------------------------------------------------ */

export interface FileEntry {
  name: string;
  /** 相对工作区根的路径，正斜杠分隔；根目录是空串 */
  path: string;
  type: "file" | "dir";
  /** 符号链接：列出名字，但读取时会再校一次是否越界 */
  symlink?: boolean;
  size?: number;
  mtime?: string;
}

export interface FileListResult {
  path: string;
  entries: FileEntry[];
  /** 单目录超过上限，只返回前 N 条 */
  truncated: boolean;
  error?: string;
}

export interface FileStatResult {
  path: string;
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  error?: string;
}

/** 预览只返回渲染需要的东西，不把源文件整个搬给界面 */
export type FileReadKind = "text" | "image" | "binary" | "too-large";

export interface FileReadResult {
  path: string;
  kind: FileReadKind;
  size: number;
  /** text 时为 UTF-8 文本 */
  text?: string;
  /** image 时为 data URL */
  dataUrl?: string;
  mime?: string;
  /** too-large / binary 的原因，直接显示给用户 */
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 内核（K2）                                                          */
/* ------------------------------------------------------------------ */

export interface KernelCandidate {
  path: string;
  source: "settings" | "kernelspec" | "PATH" | "common";
  version?: string;
  kernelPackage: "present" | "missing" | "unknown";
  problem?: string;
}

export interface KernelStatus {
  language: KernelLanguage;
  /** 用户填的路径；空 = 用机器注册项 */
  configuredPath: string;
  /** 实际会用的解释器（配置优先，否则机器默认） */
  resolvedPath: string;
  /** 本次进程内内核是否已就绪 */
  ready: boolean;
  /** 是否用“配置路径生成的 spec”而不是机器注册项 */
  specSource: "generated" | "fallback";
}

export interface KernelSpecView {
  name: string;
  displayName: string;
  language?: string;
  executable?: string;
  dir: string;
  interruptMode: "signal" | "message";
}

export interface KernelSpecsResult {
  specs: KernelSpecView[];
  problems: { dir: string; reason: string }[];
  shadowed: KernelSpecView[];
}

export interface KernelSaveResult {
  ok: boolean;
  error?: string;
  restarted?: boolean;
  status?: KernelStatus;
}

/* ------------------------------------------------------------------ */
/* 模型注册表（P1）                                                    */
/* ------------------------------------------------------------------ */

export interface CatalogModel {
  id: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, number>;
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  requiresBaseUrl: boolean;
  api: string;
  modelCount: number;
  models: CatalogModel[];
}

export interface UsageDataView {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  daily: { date: string; tokens: number }[];
  byModel: { model: string; tokens: number; runs: number }[];
  peak?: { date: string; tokens: number };
  activeDays: number;
  streak: { current: number; longest: number };
  unattributed: { runs: number; tokens: number };
  silentTurns: number;
}

export interface UsageResult {
  data: UsageDataView;
  meta: { files: number; parsed: number; reused: number; cachePath: string; error?: string };
}

export interface ProviderCatalogResult {
  providers: CatalogProvider[];
  path: string;
  error?: string;
}

export interface AddProviderInput {
  id: string;
  baseUrl: string;
  api: string;
  models: CatalogModel[];
  apiKey?: string;
}

export interface AddProviderResult {
  ok: boolean;
  error?: string;
  written?: boolean;
  warnings?: string[];
}

export interface ModelRegistryView {
  registry: { version: 1; providers: Record<string, unknown> };
  /** 注册表文件路径（<userData>/model-registry.json） */
  file: string;
  /** pi 配置目录 */
  agentDir: string;
  /** 生成目标 <agentDir>/models.json */
  piModelsPath: string;
  /** 每个 provider 是否已存密钥 */
  keys: Record<string, boolean>;
}

export interface ModelRegistrySaveResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** 是否真的写了 models.json（内容没变时为 false） */
  written: boolean;
  backup?: string;
}

export interface ModelTestResult {
  ok: boolean;
  /** HTTP 状态码；未发出请求时为空 */
  status?: number;
  ms: number;
  modelCount?: number;
  error?: string;
}

export interface SessionEntriesResult {
  entries: SessionEntry[];
  leafId: EntryId | null;
}

export interface SessionTreeResult {
  tree: SessionTreeNode[];
  leafId: EntryId | null;
}

export interface SessionSwitchResult {
  cancelled: boolean;
}

export interface ForkResult extends SessionSwitchResult {
  text?: string;
  sessionFile?: string;
  /** 空 fork 可能尚未落盘 */
  persisted?: boolean;
}

export interface ForkMessage {
  entryId: EntryId;
  text: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  /** 每百万 token 的美元单价；pi 返回时可能没有 */
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

/* ------------------------------------------------------------------ */
/* 工作区与设置                                                        */
/* ------------------------------------------------------------------ */

export interface NotebookCell {
  id: string;
  language: "python" | "r";
  code: string;
}

export interface KernelRunEvent {
  runId: string;
  ev: string;
  id?: string;
  name?: string;
  text?: string;
  mime?: string;
  data?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  status?: string;
  names?: string[];
  busy?: boolean;
}

export interface WorkspaceInfo {
  root: string;
  recent: string[];
}

export interface WorkspaceOpenResult {
  root: string;
  initialized: boolean;
  migratedSessions: number;
}

export interface WorkspacePaths {
  root: string; // 绝对路径
  dataRaw: string;
  dataProcessed: string;
  analysisScripts: string;
  analysisNotebooks: string;
  resultsTables: string;
  resultsModels: string;
  resultsReports: string;
  figures: string;
  stateDir: string; // <root>/.omcp
  sessionsDir: string;
  logsDir: string;
  policyFile: string;
}

export interface AppSettings {
  version: 1;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  kernel: {
    python: string;
    r: string;
  };
  workspaceRoot?: string;
  policyPath?: string;
}

/* ------------------------------------------------------------------ */
/* UI ↔ 主进程                                                         */
/* ------------------------------------------------------------------ */

export interface PromptOptions {
  /** 运行中投递：steer = 立刻转向，followUp = 排到这一轮后面 */
  streamingBehavior?: "steer" | "followUp";
}

export interface ClearQueueResult {
  ok: boolean;
  steering: string[];
  followUp: string[];
}

export interface PreloadApi {
  prompt(
    text: string,
    images?: ImageAttachment[],
    opts?: PromptOptions,
    runtimeId?: string,
  ): Promise<PromptResult>;
  steer(text: string, runtimeId?: string): Promise<PromptResult>;
  /** 撤掉 pi 的待发队列，返回被撤回的文本（修改 2） */
  clearQueue(runtimeId?: string): Promise<ClearQueueResult>;
  followUp(text: string, runtimeId?: string): Promise<PromptResult>;
  abort(runtimeId?: string): Promise<boolean>;
  restart(): Promise<boolean>;
  newSession(runtimeId?: string): Promise<boolean>;
  getSessions(runtimeId?: string): Promise<SessionSummary[]>;
  getSessionMeta(): Promise<SessionMetaResult>;
  setSessionMeta(sessionFile: string, patch: SessionMetaPatch): Promise<{ ok: boolean; error?: string }>;
  listFiles(path: string): Promise<FileListResult>;
  /** 产物清单：账本（工具产出）+ 约定目录（figures/、results/） */
  listArtifacts(): Promise<ArtifactListResult>;
  statFile(path: string): Promise<FileStatResult>;
  readFile(path: string): Promise<FileReadResult>;
  getModelRegistry(): Promise<ModelRegistryView>;
  /** 发送前预检：缺凭据 / 地址不对 / 模型不存在 */
  modelPreflight(provider: string, modelId: string): Promise<ModelPreflightView>;
  /** 补全连接信息对话框的数据（含将写入的 models.json 片段，不含真实密钥） */
  modelSetupInfo(provider: string): Promise<ModelSetupInfo>;
  /** 保存连接信息 + 密钥；成功后会重启 pi */
  modelSetupSave(input: ModelSetupInput): Promise<ModelSetupResult>;
  setModelRegistry(raw: unknown): Promise<ModelRegistrySaveResult>;
  importModelRegistry(): Promise<{ ok: boolean; count: number; skipped: string[]; error?: string }>;
  setModelProviderKey(id: string, key: string): Promise<ModelRegistrySaveResult>;
  testModelProvider(id: string): Promise<ModelTestResult>;
  detectKernels(language: KernelLanguage): Promise<KernelCandidate[]>;
  getKernelStatus(): Promise<KernelStatus[]>;
  saveKernelPath(language: KernelLanguage, path: string): Promise<KernelSaveResult>;
  listKernelSpecs(): Promise<KernelSpecsResult>;
  getProviderCatalog(): Promise<ProviderCatalogResult>;
  probeModelEndpoint(baseUrl: string, apiKey: string, api?: string): Promise<ModelTestResult>;
  addModelProvider(input: AddProviderInput): Promise<AddProviderResult>;
  getUsage(): Promise<UsageResult>;
  listPlugins(): Promise<PluginsResult>;
  setPluginFlag(pluginId: string, familyKey: string | null, on: boolean): Promise<PluginsResult>;
  memoryList(): Promise<MemoryQueue>;
  memoryAdopt(id: string): Promise<{ ok: boolean; error?: string; queue?: MemoryQueue }>;
  memoryReject(id: string): Promise<{ ok: boolean; error?: string; queue?: MemoryQueue }>;
  getMessages(): Promise<AgentMessage[]>;
  respondApproval(decision: ApprovalDecision): Promise<void>;
  getPolicy(): Promise<PolicyInfo>;
  reloadPolicy(): Promise<PolicyInfo>;
  listGrants(): Promise<PersistentGrant[]>;
  revokeGrant(id: string): Promise<boolean>;
  clearGrants(): Promise<boolean>;
  readAudit(limit?: number): Promise<AuditEntryView[]>;
  queryAudit(query?: AuditQuery): Promise<AuditPage>;
  getAppSettings(): Promise<AppSettingsView>;
  setAppSettings(patch: Partial<AppSettingsView>): Promise<AppSettingsView>;
  pruneGrants(): Promise<number>;
  getSettingsDetail(): Promise<AppSettingsDetail>;
  updateSettingsDetail(patch: Partial<AppSettingsDetail>): Promise<AppSettingsDetail>;
  checkUpdate(): Promise<UpdateCheckResult>;
  exportDiagnostics(): Promise<string | null>;
  /** 用系统默认浏览器打开 http/https/mailto 链接；主进程再校验一次协议 */
  openExternal(url: string): Promise<{ ok: boolean; error?: string }>;
  getPiInfo(): Promise<PiRuntimeInfo>;
  getVisionSettings(): Promise<VisionSettingsView>;
  setVisionSettings(patch: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<VisionSettingsView>;
  testVision(): Promise<DescribeResult>;
  describeImage(data: string, mimeType?: string): Promise<DescribeResult>;
  loadRoute(): Promise<RouteLoadResult>;
  saveRoute(doc: RouteDoc): Promise<RouteLoadResult & { ok: boolean }>;
  exportRoute(): Promise<{ path: string | null; error?: string }>;
  getPlanStatus(): Promise<PlanGateStatus>;
  setPlanMode(enabled: boolean): Promise<PlanGateStatus>;
  approvePlan(planPath: string): Promise<PlanGateStatus>;
  listSkills(): Promise<SkillInfo[]>;
  readSkill(name: string): Promise<string | null>;
  setSkillEnabled(name: string, enabled: boolean): Promise<boolean>;
  createSkill(slug: string, description: string): Promise<string | null>;
  signalReady(): void;
  exportAudit(): Promise<string | null>;
  onApprovalResolved(cb: (info: { requestId: string; scope: ApprovalScope }) => void): () => void;
  onPolicyChanged(cb: (info: PolicyInfo) => void): () => void;
  getState(): Promise<SessionState>;
  getStats(): Promise<SessionStats>;
  getBudget(): Promise<BudgetStatus>;
  getWorkspace(): Promise<WorkspaceInfo>;
  getWorkspaceIndex(): Promise<WorkspaceIndexEntry[]>;
  deleteSession(sessionFile: string): Promise<{ ok: boolean; error?: string }>;
  pickWorkspace(): Promise<WorkspaceOpenResult | null>;
  openWorkspace(root: string): Promise<WorkspaceOpenResult>;
  getTree(): Promise<SessionTreeResult>;
  getEntries(since?: EntryId): Promise<SessionEntriesResult>;
  getForkMessages(): Promise<ForkMessage[]>;
  getAvailableModels(): Promise<ModelInfo[]>;
  /** 当前模型可用的推理档位（顺序以 pi 为准） */
  getThinkingLevels(runtimeId?: string): Promise<ThinkingLevel[]>;
  switchSession(sessionFile: SessionFile, runtimeId?: string): Promise<SessionSwitchResult>;
  fork(entryId: EntryId, runtimeId?: string): Promise<ForkResult>;
  clone(runtimeId?: string): Promise<SessionSwitchResult>;
  setModel(provider: string, modelId: string, runtimeId?: string): Promise<SetModelResult>;
  setThinkingLevel(level: ThinkingLevel, runtimeId?: string): Promise<SetModelResult>;
  getPermission(): Promise<PermissionState>;
  setPermission(mode: PermissionMode, asDefault: boolean): Promise<PermissionState>;
  exportHtml(outputPath?: string): Promise<string | null>;
  onEvent(cb: (item: PiStreamItem) => void): () => void;
  onTurnPhase(cb: (event: TurnPhaseEvent) => void): () => void;
  /** pi 进程已启动但可能还在初始化；true 表示 RPC 已经真正响应过 */
  isPiReady(): Promise<boolean>;
  onPiReady(cb: (ready: boolean) => void): () => void;
  pickUpload(kind: UploadKind): Promise<PickUploadResult>;
  importUploads(paths: string[], importId: string): Promise<{ ok: boolean; files: string[]; error?: string }>;
  cancelUpload(importId: string): Promise<boolean>;
  onUploadProgress(cb: (progress: UploadProgress) => void): () => void;
  /** 拖拽时把 File 转成本机路径（Electron webUtils） */
  pathForFile(file: File): string;
  onApproval(cb: (req: ApprovalRequest) => void): () => void;
  onStatus(cb: (status: BridgeStatus) => void): () => void;
  onError(cb: (error: AppError) => void): () => void;
  onWorkspace(cb: (info: WorkspaceInfo) => void): () => void;
  loadNotebook(): Promise<NotebookCell[]>;
  saveNotebook(cells: NotebookCell[]): Promise<boolean>;
  runCell(runId: string, code: string, language?: "python" | "r"): Promise<boolean>;
  interruptKernel(language?: "python" | "r"): Promise<boolean>;
  restartKernel(language?: "python" | "r"): Promise<boolean>;
  getVariables(language?: "python" | "r"): Promise<string[]>;
  onKernelEvent(cb: (ev: KernelRunEvent) => void): () => void;
  /* MCP（P1） */
  listMcpServers(): Promise<McpListView>;
  /** 有副作用：会启动所有已启用服务器 */
  checkMcpServers(name?: string): Promise<McpListView>;
  saveMcpServer(input: { json: string; name?: string }): Promise<McpSaveResult>;
  removeMcpServer(name: string): Promise<McpListView>;
  setMcpFlag(
    name: string,
    flag: "enabled" | "trusted",
    value: boolean,
    fingerprint?: string,
  ): Promise<McpListView>;
  setMcpSecret(name: string, key: string, value: string): Promise<{ ok: boolean; list: McpListView }>;
  openMcpConfig(): Promise<{ ok: boolean; path: string; error?: string }>;
  loginMcpServer(name: string): Promise<McpLoginResult>;
  listRuntimes(): Promise<RuntimeView[]>;
  getRuntimeMessages(id: string): Promise<AgentMessage[]>;
  getRuntimeState(id: string): Promise<SessionState | null>;
  getRuntimeStats(id: string): Promise<SessionStats | null>;
  onRuntimeChanged(cb: (list: RuntimeView[]) => void): () => void;
  createRuntime(input?: {
    workspaceRoot?: string;
    sessionFile?: string | null;
  }): Promise<RuntimeView | null>;
  activateRuntime(id: string): Promise<RuntimeView[]>;
  closeRuntime(id: string): Promise<RuntimeView[]>;
  /** 修改 4 · M0：会话级入口（标签 = 会话） */
  getSessionBoard(): Promise<SessionBoardView>;
  openSession(file: string): Promise<SessionOpenView>;
  closeSession(file: string): Promise<SessionBoardView>;
  onSessionChanged(cb: (board: SessionBoardView) => void): () => void;
  onSessionOpened(cb: (payload: { file: string }) => void): () => void;
  /** 修改 4 · M1：主进程的转写快照（切回会话时整段拿） */
  getTranscript(file: string): Promise<{ key: string; revision: number; items: unknown[]; unread: number; cold: boolean }>;
  /** 系统提示（崩溃中断、内核回收）：直接进当前可见会话的转写 */
  onSessionNote(cb: (payload: { file: string; text: string }) => void): () => void;
  /** 会话内核因空闲被回收（变量已清空） */
  onKernelReaped(cb: (payload: { key: string; file: string | null }) => void): () => void;
}

export type IpcRequest =
  | { channel: "pi:prompt"; text: string; images?: ImageAttachment[] }
  | { channel: "pi:steer"; text: string }
  | { channel: "pi:follow-up"; text: string }
  | { channel: "pi:abort" }
  | { channel: "pi:restart" }
  | { channel: "pi:new-session" }
  | { channel: "pi:sessions" }
  | { channel: "session-meta:get" }
  | { channel: "session-meta:set"; sessionFile: string; patch: SessionMetaPatch }
  | { channel: "fs:list"; path: string }
  | { channel: "fs:stat"; path: string }
  | { channel: "fs:read"; path: string }
  | { channel: "models:registry-get" }
  | { channel: "models:registry-set"; registry: unknown }
  | { channel: "models:import" }
  | { channel: "models:key-set"; id: string; key: string }
  | { channel: "models:test"; id: string }
  | { channel: "kernel:detect"; language: KernelLanguage }
  | { channel: "kernel:status" }
  | { channel: "kernel:save-path"; language: KernelLanguage; path: string }
  | { channel: "kernel:specs" }
  | { channel: "models:catalog" }
  | { channel: "models:probe"; baseUrl: string; apiKey: string }
  | { channel: "models:add-provider"; input: AddProviderInput }
  | { channel: "usage:get" }
  | { channel: "pi:messages" }
  | { channel: "pi:state" }
  | { channel: "pi:stats" }
  | { channel: "pi:budget" }
  | { channel: "workspace:current" }
  | { channel: "workspace:pick" }
  | { channel: "workspace:open"; root: string }
  | { channel: "notebook:load" }
  | { channel: "notebook:save"; cells: NotebookCell[] }
  | { channel: "kernel:run"; runId: string; code: string; language?: "python" | "r" }
  | { channel: "kernel:interrupt"; language?: "python" | "r" }
  | { channel: "kernel:restart"; language?: "python" | "r" }
  | { channel: "kernel:variables"; language?: "python" | "r" }
  | { channel: "pi:tree" }
  | { channel: "pi:entries"; since?: EntryId }
  | { channel: "pi:fork-messages" }
  | { channel: "pi:models" }
  | { channel: "pi:switch-session"; sessionFile: SessionFile }
  | { channel: "pi:fork"; entryId: EntryId }
  | { channel: "pi:clone" }
  | { channel: "pi:set-model"; provider: string; modelId: string }
  | { channel: "pi:export-html"; outputPath?: string }
  | { channel: "approval:respond"; decision: ApprovalDecision }
  | { channel: "policy:current" }
  | { channel: "policy:reload" }
  | { channel: "grants:list" }
  | { channel: "grants:revoke"; id: string }
  | { channel: "grants:clear" }
  | { channel: "grants:prune" }
  | { channel: "settings:detail" }
  | { channel: "settings:detail:set"; patch: Partial<AppSettingsDetail> }
  | { channel: "update:check" }
  | { channel: "diag:export" }
  | { channel: "app:ready" }
  | { channel: "route:load" }
  | { channel: "route:save"; doc: RouteDoc }
  | { channel: "route:export" }
  | { channel: "plan:status" }
  | { channel: "plan:set"; enabled: boolean }
  | { channel: "plan:approve"; planPath: string }
  | { channel: "pi:info" }
  | { channel: "vision:get" }
  | { channel: "vision:set"; patch: { baseUrl?: string; model?: string; apiKey?: string } }
  | { channel: "vision:test" }
  | { channel: "vision:describe"; data: string; mimeType?: string }
  | { channel: "skills:list" }
  | { channel: "skills:read"; name: string }
  | { channel: "skills:set-enabled"; name: string; enabled: boolean }
  | { channel: "skills:create"; slug: string; description: string }
  | { channel: "audit:read"; limit?: number }
  | { channel: "audit:query"; query?: AuditQuery }
  | { channel: "settings:app" }
  | { channel: "settings:app:set"; patch: Partial<AppSettingsView> }
  | { channel: "audit:export" };

export type ErrorCode =
  | "E_PI_SPAWN"
  | "E_PI_EXIT"
  | "E_PI_TIMEOUT"
  | "E_MODEL_AUTH"
  | "E_PI_PROMPT"
  | "E_MODEL_SWITCH"
  | "E_MODEL_RATE"
  | "E_MODEL_NETWORK"
  | "E_TOOL_BLOCKED"
  | "E_TOOL_TIMEOUT"
  | "E_TOOL_ERROR"
  | "E_BUDGET"
  | "E_KERNEL_START"
  | "E_KERNEL_DEAD"
  | "E_KERNEL_BUSY"
  | "E_SESSION_MISSING"
  | "E_SESSION_CORRUPT"
  | "E_EXPORT_FAILED"
  | "E_USER_ABORT"
  | "E_UNKNOWN";

export interface AppError {
  code: ErrorCode;
  severity: "info" | "warning" | "error" | "fatal";
  title: string;
  detail: string;
  /** 技术原文：只在「查看原始错误」折叠区与日志里出现，界面主行不显示 */
  raw?: string;
  recoverable: boolean;
  action?:
    | "retry"
    | "restart-pi"
    | "restart-kernel"
    | "open-settings"
    | "open-log"
    | "none";
}

export interface BudgetStatus {
  sessionUsd: number;
  dailyUsd: number;
  sessionLimit: number;
  dailyLimit: number;
  alertRatio: number;
}

export type IpcEvent =
  | { channel: "pi:event"; item: PiStreamItem }
  | { channel: "upload:progress"; progress: UploadProgress }
  | { channel: "pi:turn"; event: TurnPhaseEvent }
  | { channel: "bridge:pi-ready"; ready: boolean }
  | { channel: "approval:request"; request: ApprovalRequest }
  | { channel: "approval:resolved"; requestId: string; scope: ApprovalScope }
  | { channel: "policy:changed"; info: PolicyInfo }
  | { channel: "bridge:status"; status: BridgeStatus }
  | { channel: "bridge:error"; error: AppError }
  | { channel: "workspace:changed"; info: WorkspaceInfo }
  | { channel: "kernel:event"; event: KernelRunEvent };

/** 产物（参考 DAWN 的产物契约）：账本记的 + 约定目录扫出来的。 */
export type ArtifactKind = "code" | "markdown" | "text" | "image" | "data" | "other";

export interface ArtifactItem {
  /** 工作区相对路径，统一 / 分隔 */
  path: string;
  name: string;
  dir: string;
  kind: ArtifactKind;
  size: number | null;
  mtime: string | null;
  /** 刷新时现查：账本里有、磁盘上没了 → 界面显示「已不存在」 */
  exists: boolean;
  origin: "run" | "observed";
  tool?: string;
  ts?: string;
}

export interface ArtifactListResult {
  artifacts: ArtifactItem[];
  /** 有工具调用但产出未知的次数（bash / run_code） */
  unknownRuns: number;
  /** 其中来自约定目录扫描的条数 */
  observed: number;
  scannedAt: string;
  error?: string;
}
