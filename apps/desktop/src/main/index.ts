import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { arch as osArch, platform as osPlatform } from "node:os";
import type {
  AgentMessage,
  AppError,
  AppSettingsView,
  ApprovalDecision,
  AppSettingsDetail,
  AuditPage,
  DescribeResult,
  ImageAttachment,
  PiRuntimeInfo,
  PlanGateStatus,
  RouteDoc,
  RouteLoadResult,
  SkillInfo,
  VisionSettingsView,
  AuditQuery,
  UpdateCheckResult,
  ApprovalRequest,
  ApprovalScope,
  ApprovalTitlePayload,
  AuditEntryView,
  BridgeStatus,
  BudgetStatus,
  ForkResult,
  KernelRunEvent,
  ModelInfo,
  NotebookCell,
  PiEvent,
  PiStreamItem,
  PiResponse,
  PickUploadResult,
  PickedUpload,
  UploadKind,
  PersistentGrant,
  PermissionMode,
  PermissionState,
  PolicyInfo,
  PromptResult,
  SessionState,
  SetModelResult,
  ThinkingLevel,
  SessionStats,
  SessionSummary,
  SessionBoardView,
  SessionOpenView,
  SessionView,
  SessionSwitchResult,
  SessionTreeResult,
  WorkspaceInfo,
  WorkspaceIndexEntry,
  WorkspaceOpenResult,
} from "@oh-my-coding-pi/shared";
import { APPROVAL_OPTIONS, APPROVAL_TITLE_PREFIX, UPLOAD_IMAGE_MAX_BYTES, UPLOAD_IMAGE_MAX_COUNT } from "@oh-my-coding-pi/shared";
import { isThinkingLevel } from "@oh-my-coding-pi/shared";
import { PiSupervisor } from "./supervisor";
import { SessionRuntime } from "./session-runtime";
import { KernelManager, kernelKeyFor } from "./kernel-manager";
import { RuntimeManager } from "./runtime-manager";
import { SessionRegistry, crashOutcome, sessionKey } from "./session-registry";
import { TranscriptHub } from "./transcript-hub";
import { SlotPool } from "./slot-pool";
import { SubagentGate, startSubagentGateServer } from "./subagent-gate";
import { RpcClient } from "./rpc-client";
import { TurnTrace } from "./turn-trace";
import { EventPump } from "./event-pump";
import {
  checkDiskSpace,
  classifyUpload,
  copyWithProgress,
  filtersFor,
  readImageBase64,
  safeFileName,
  uniqueDestination,
  uploadDateDir,
} from "./upload-service";
import { KernelService } from "./kernel-service";
import { KernelBroker } from "./kernel-broker";
import { PolicyService } from "./policy-service";
import { ArtifactLedger } from "./artifact-ledger";
import { ArtifactService } from "./artifact-service";
import { GrantStore } from "./grants";
import { AuditLog, type AuditEntry } from "./audit";
import { createSkill, readSkill, scanSkills, setSkillEnabled } from "./skills";
import { SecretStore } from "./secrets";
import { describeImage, formatDescription } from "./vision";
import { exportRoute, isValidPlanPath, loadRoute, planAbsPath, saveRoute } from "./route";
import { PlanGateBook, planDigest, verifyPlanFile, type PlanGateState } from "./plan-approval";
import { applyCost, budgetStatusOf } from "./budget-ledger";
import {
  buildPiProviders,
  emptyRegistry,
  fromPiProviders,
  mergeModelsJson,
  previewPiProvider,
  providerEnvKey,
  validateRegistry,
  type ModelRegistry,
  type RegistryModel,
} from "./model-registry";
import { applyAutoTitles, loadSessionMeta, patchSessionMeta, sessionMetaKey } from "./session-meta";
import { briefTitle, extractUserText, uniqueTitle } from "./session-title";
import { listWorkspaceDir, readWorkspaceFile, statWorkspacePath } from "./file-service";
import { discoverKernelSpecs, specCandidates } from "./kernel-specs";
import { loadProviderCatalog, type CatalogProvider } from "./provider-catalog";
import { credentialEnvNames, hasEnvCredential } from "./model-env";
import { preflightModel } from "./model-preflight";

import { probeModels } from "./model-probe";
import { BrowserService } from "./browser-service";
import { aggregateUsage } from "./usage-stats";
import { emptyCache, scanSessions, type ScanCache } from "./usage-scan";
import { probeInterpreters, realDeps } from "./kernel-probe";
import { expectedVersion, probeSystemPi, resolvePi, runVersion } from "./pi-runtime";
import { checkForUpdate } from "./updater";
import { McpService } from "./mcp-service";
import { buildDiagnosticZip, tailFile } from "./diagnostics";
import { adoptMemory, readMemoryQueue, rejectMemory } from "./memory-store";
import { SwitchTiming } from "./switch-timing";
import { sessionsDirOf, workspaceOfSession } from "./session-locate";
import { SessionIndex } from "./session-index";
import {
  forgetProjects,
  normalizeProjects,
  renameProject,
  upsertProject,
  type ProjectRecord,
} from "./projects";
// 插件册只有一份定义（ADR-045）：主进程构建期内联它，扩展侧相对路径导入同一个文件
import {
  PLUGINS,
  defaultFlags,
  enabledFamilyKeys,
  familyEnabled,
  pluginEnabled,
  type PluginFlags,
} from "../../../../packages/plugin-ext/src/registry";

app.setName("oh-my-coding-pi");

const PROCESS_STARTED_AT = Date.now();
/** 修改 5 · S5：切换耗时埋点（logs/timings.jsonl） */
const switchTiming = new SwitchTiming(() => join(app.getPath("userData"), "logs", "timings.jsonl"));
/** 修改 5 · C6：会话列表的异步扫描与增量缓存 */
const sessionIndex = new SessionIndex();
let firstInteractiveAt = 0;

const SELFTEST = process.env.P1_SELFTEST === "1";
const SELFTEST_MODE = process.env.P1_SELFTEST_MODE || "";

let win: BrowserWindow | null = null;
let workspaceRoot = "";
let workspaceStateFile = "";
let workspacesFile = "";
let sessionDir = "";
let stateFile = "";
let exportsDir = "";
let screenshotsDir = "";
let logsDir = "";
let settingsFile = "";
let currentSessionFile: string | null = null;
const budget = { sessionLimit: 1, dailyLimit: 5, alertRatio: 0.8 };
let dailyDate = "";
let dailySpent = 0;
let sessionCosts: Record<string, number> = {};
let abortTimer: NodeJS.Timeout | null = null;
let selftestDone = false;
let selftestTimer: NodeJS.Timeout | null = null;
let quitting = false;

let kernelManager: KernelManager | null = null;
/** 新建 runtime 时复用同一套扩展 */
let runtimeExtensions: string[] = [];
let pythonKernel: KernelService | null = null;
let rKernel: KernelService | null = null;
let kernelBroker: KernelBroker | null = null;
let browserService: BrowserService | null = null;
let grants: GrantStore | null = null;
let auditLog: AuditLog | null = null;
let policyService: PolicyService | null = null;
let artifactService: ArtifactService | null = null;
let settingsPolicyPath: string | undefined;
const appSettings = {
  grantTtlDays: 30,
  readonlyNotebook: false,
  // 默认留空：装好之后由用户自己配置 provider / 模型
  provider: process.env.PI_PROVIDER || "",
  model: process.env.PI_MODEL || "",
  pythonPath: "",
  rPath: "",
  updateRepo: "",
  trustProject: false,
  visionBaseUrl: "",
  visionModel: "",
  piConfigDir: "",
  sessionLimit: 1,
  dailyLimit: 5,
  /** 插件开关：<插件键> 整包、<族键> 单族，"1" = 关（ADR-045） */
  plugins: defaultFlags() as PluginFlags,
  /** 三档权限的应用默认值；会话可单独覆盖 */
  permissionMode: "ask-risky" as PermissionMode,
  /** 推理强度默认档：新会话与 pi 重启后沿用（pi 自带默认值是 medium，这里保持一致） */
  thinkingLevel: "medium" as ThinkingLevel,
  /** P3c：活跃 runtime 上限与空闲回收分钟 */
  maxRuntimes: Math.max(
    1,
    Math.min(4, Number(process.env.OMCP_MAX_RUNTIMES ?? 3) || 3),
  ),
  runtimeIdleMinutes: Math.max(
    1,
    Number(process.env.OMCP_RUNTIME_IDLE_MINUTES ?? 30) || 30,
  ),
};
interface PendingApproval {
  request: ApprovalRequest;
  timer: NodeJS.Timeout;
  sessionKey: string;
  /** P1b2c3：审批来自哪个 runtime；默认 default */
  runtimeId: string;
  /** 回复 extension_ui_response 要发回哪个进程 */
  rpc: RpcClient;
  /** 审批所属 runtime 的工作区；grants 按它记 */
  workspaceRoot: string;
}
const pendingApprovals = new Map<string, PendingApproval>();
let secretStore: SecretStore | null = null;
/** MCP 配置服务：lazy 创建（secretStore 与 workspaceRoot 就绪后） */
let mcpService: McpService | null = null;
/**
 * 方案期门（修改 4 · M2：按**会话**记）。
 *
 * 改之前是一个单对象：A 会话批准了方案，B 会话立刻也变成"已批准只读"，
 * 反过来 B 一改方案内容，A 的批准也跟着失效。方案文件是工作区的，
 * 但「批没批」是这段对话的状态。
 */
const planGates = new PlanGateBook();
/** 还没有会话文件时（新建工作区）挂在工作区上 */
const PLAN_WS_KEY = "__workspace__";

function resetPlanGate(key: string): void {
  planGates.revoke(key);
}

function planGateFor(key: string): PlanGateState {
  return planGates.for(key);
}

/** 策略服务给了 runtimeId / sessionKey，换算成方案期的键 */
function planKeyOf(ctx?: { runtimeId?: string; sessionKey?: string }): string {
  if (ctx?.sessionKey) return `session:${sessionKey(ctx.sessionKey)}`;
  if (ctx?.runtimeId) {
    const file = runtimeManager.get(ctx.runtimeId)?.sessionFile;
    if (file) return `session:${sessionKey(file)}`;
  }
  // 没有上下文（自测里的直接调用、旧客户端）：按"用户看着的那段"算
  return visiblePlanKey();
}

/** 界面操作（plan:status / set / approve）作用在"此刻看着的那段会话"上 */
function visiblePlanKey(): string {
  return currentSessionFile ? `session:${sessionKey(currentSessionFile)}` : PLAN_WS_KEY;
}
/** 模型能力缓存：provider/model → 是否支持图片 */
const visionCapability = new Map<string, boolean>();
let tokenProbe: { startedAt: number; resolve: (ms: number) => void } | null = null;

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * 回合时序：只记阶段与长度，不记正文；OMCP_PERF_TRACE=0 可关闭写盘。
 *
 * 修改 4 · M2：一个槽一份。改之前是全局一个——两个会话同时跑时，
 * 后一轮 `begin()` 直接返回 null（"已有回回合在跑"），于是后台会话
 * 根本没有记录，前台那轮的阶段还会被对方的 tool 事件污染。
 */
const perfTraces = new Map<string, TurnTrace>();
function traceOf(runtimeId = "default"): TurnTrace {
  let trace = perfTraces.get(runtimeId);
  if (!trace) {
    trace = new TurnTrace({
      file: () => (workspaceRoot ? join(workspaceRoot, ".omcp", "logs", "perf.jsonl") : null),
      enabled: process.env.OMCP_PERF_TRACE !== "0",
    });
    trace.setPhaseSink((ev) => send("pi:turn", { ...ev, runtimeId }));
    perfTraces.set(runtimeId, trace);
  }
  return trace;
}
/** 默认槽的这一份（兼容旧引用） */
const turnTrace = traceOf("default");

/**
 * 运行时管理器（修改 4 · M0 起只做实例登记）。
 * 会话身份与准入由 `sessionRegistry` / `slotPool` 负责——
 * `runtimeManager` 留着是因为它同时管着 ServiceHub 的 token 路由。
 */
const runtimeManager = new RuntimeManager({ maxRuntimes: appSettings.maxRuntimes });
const sessionRegistry = new SessionRegistry();
const defaultRuntime = runtimeManager.create({
  id: "default",
  provider: process.env.PI_PROVIDER || "",
  model: process.env.PI_MODEL || "",
  emit: emitRuntimeEvent,
  pumpEnabled: process.env.OMCP_EVENT_PUMP !== "0",
});
const supervisor = defaultRuntime.supervisor;
const rpc = defaultRuntime.rpc;
/** 合并逐 token 的 text/thinking 增量；OMCP_EVENT_PUMP=0 时退化为逐条转发。 */
const eventPump = defaultRuntime.pump;

/**
 * 槽池（会话 → pi 进程的准入）。
 *
 * 默认 runtime 作为第一个槽被领养：它仍然叫 `default`，所有老 IPC 继续用它，
 * 但它现在也会被准入规则停掉/复用——这正是「切走不停、满员挂起最久未用」的基础。
 */
/**
 * 转录中枢（修改 4 · M1）：会话的转写由主进程按会话记，切走不停、刷新不丢。
 * 键与会话登记表一致：`session:<规范化路径>`，还没有会话文件时按槽兜底。
 */
/**
 * 子任务并发闸（修改 4 · M4）：名额是**全局**的，因为限流的是 provider。
 * 2 个槽 × 每槽 4 个子任务 = 8 个请求同时在飞，不挡就会整批 429。
 */
const subagentGate = new SubagentGate({
  capacity: Math.max(1, Math.min(16, Number(process.env.OMCP_SUBAGENT_CONCURRENCY ?? 4) || 4)),
});
let subagentGateServer: { url: string; token: string; close(): void } | null = null;

const transcriptHub = new TranscriptHub();

function hubKeyForFile(file: string | null | undefined): string {
  return file ? `session:${sessionKey(file)}` : "session:none";
}

function hubKeyForSlot(runtimeId: string): string {
  return hubKeyForFile(slotPool.get(runtimeId)?.sessionFile ?? null).replace(
    "session:none",
    `runtime:${runtimeId}`,
  );
}

/**
 * 槽意外退出（修改 4 · M3）。
 *
 * 之前不管哪种退出，界面上都是"突然不说话了"：用户分不清是自己停的、
 * 被空闲回收了，还是 pi 崩了。这里把三种分开：
 *
 *  - 主动停（回收/抢占/换工作区）→ 什么都不说，标签显示"已挂起"；
 *  - 崩溃且有回合在飞 → 会话标 `interrupted`，转写里留一句"本轮被中断，可重发"；
 *  - 崩溃但当时空闲 → 只留一句"已自动重启"。
 *
 * 不自动重发：重发是用户的决定，不是我们的。
 */
function markSlotCrash(runtimeId: string): void {
  const runtime = runtimeManager.get(runtimeId);
  if (!runtime || runtime.isStopping) return;
  const file = runtime.sessionFile;
  const key = hubKeyForFile(file);
  const outcome = crashOutcome(runtime.lastExitWhileBusy);
  if (file) {
    sessionRegistry.setState(file, outcome.state);
    transcriptHub.system(key, outcome.note);
    // 中枢里有了还不够：正在看这段会话的人应当**马上**看到，而不是切走再回来
    send("session:note", { file, text: outcome.note });
  }
  send("session:changed", sessionBoard());
}

/** 这段会话此刻就显示在窗口里（用来决定要不要计未读） *//** 这段会话此刻就显示在窗口里（用来决定要不要计未读） */
function isVisibleSession(file: string | null): boolean {
  if (!file || !currentSessionFile) return false;
  return sessionKey(file) === sessionKey(currentSessionFile);
}

const slotPool = new SlotPool({
  registry: sessionRegistry,
  maxSlots: appSettings.maxRuntimes,
  createSlot: ({ id, workspace, sessionFile }) => {
    const runtime = runtimeManager.create({
      id,
      provider: supervisor.getProvider(),
      model: supervisor.getModel(),
      emit: emitRuntimeEvent,
      pumpEnabled: process.env.OMCP_EVENT_PUMP !== "0",
      workspaceRoot: workspace,
      sessionFile,
      autoAttach: true,
      onExtensionUi: (ev) => {
        handleExtensionUi(ev as Parameters<typeof handleExtensionUi>[0], runtime);
      },
    });
    // 修改 4 · M3：后台槽崩溃也要有痕迹（默认槽由它自己的 exit 接线管）
    runtime.supervisor.on("exit", () => markSlotCrash(id));
    // 修改 5 · C4：会话落在**这个槽自己的工作区**，不靠全局 sessionDir——
    // 否则在 B 里新建的会话会被写到 A 的目录下。
    runtime.setSessionDir(sessionsDirOf(workspace));
    // 崩溃后 supervisor 会退避重启；探到就绪就推一次，界面据此把手收回来。
    // 不探的话 ready 永远是 false，输入框会一直显示"pi 正在启动"。
    runtime.supervisor.on("spawn", () => {
      void runtime
        .waitReady(120_000)
        .then(() => send("session:changed", sessionBoard()))
        .catch(() => undefined);
    });
    return runtime;
  },
  disposeSlot: (slot) => {
    cancelPendingApprovals(slot.id);
    // 这个槽的子进程可能没来得及还名额；不留孤儿占用
    subagentGate.releaseAll(slot.id);
    // 内核跟着会话走：关槽不动内核，交给空闲回收（M2）
    runtimeAuditLogs.delete(slot.id);
    runtimeManager.forget(slot.id);
    slot.dispose();
  },
  isBlocked: (slotId) => [...pendingApprovals.values()].some((pending) => pending.runtimeId === slotId),
  // 默认槽被 index.ts 直接持有（supervisor / rpc / eventPump），只能挂起不能销毁
  pinnedSlots: ["default"],
  onBind: (slotId, file) => {
    runtimeManager.updateSession(slotId, file);
    // 绑定发生在 activeId 改之前，所以按"绑的是不是可见那段"判断，不按槽
    if (file && file === currentSessionFile) pointKernelsAt(file);
  },
  onDequeued: (_slotId, file) => {
    send("session:opened", { file });
  },
  onChanged: () => {
    runtimeManager.setActive(slotPool.activeSlotId);
    send("session:changed", sessionBoard());
    send("runtime:changed", runtimeManager.list());
  },
});
slotPool.adopt(defaultRuntime);

if (!SELFTEST) {
  const reaper = setInterval(() => {
    const stopped = slotPool.reapIdle(Math.max(1, appSettings.runtimeIdleMinutes) * 60_000);
    if (stopped.length) send("runtime:changed", runtimeManager.list());
    // 内核按会话回收：关掉就不再有变量，必须说出来（M2）
    const reapedKernels = kernelManager?.reapIdle(kernelIdleMs()) ?? [];
    for (const item of reapedKernels) {
      if (!item.wasRunning) continue;
      const file = item.key.startsWith("session:") ? item.key.slice("session:".length) : null;
      if (file) {
        transcriptHub.system(
          hubKeyForFile(file),
          "内核已因空闲关闭：变量已清空，再运行代码会重新启动内核。",
        );
      }
      if (file) send("session:note", { file, text: "内核已因空闲关闭：变量已清空，再运行代码会重新启动内核。" });
      send("session:kernel-reaped", { key: item.key, file });
    }
  }, 60_000);
  reaper.unref?.();
}

/** P2a：所有 runtime 的事件统一出口；renderer 按 runtimeId 分流 */
function emitRuntimeEvent(ev: PiEvent, runtimeId: string): void {
  turnTrace.countIpcSent();
  // 修改 4 · M1：转写归约在主进程做一份，后台会话照样记（切走不停的基础）
  const hubKey = hubKeyForSlot(runtimeId);
  const slotFile = slotPool.get(runtimeId)?.sessionFile ?? null;
  const before = transcriptHub.summary(hubKey).unread;
  transcriptHub.ingest(hubKey, ev);
  if (isVisibleSession(slotFile)) {
    transcriptHub.clearUnread(hubKey);
  } else if (transcriptHub.summary(hubKey).unread !== before) {
    // 后台会话多了一轮：把未读数推到界面（只给标量，不搬条目）
    send("session:changed", sessionBoard());
  }
  // 标签上的状态点：会话忙/闲跟着事件走（默认槽也在这里，不另接一份）
  if (ev.type === "agent_start" || ev.type === "agent_settled") {
    if (markSessionFromEvent(runtimeId, ev.type === "agent_start")) {
      send("session:changed", sessionBoard());
    }
  }
  if (runtimeId !== "default") {
    // 默认槽由它自己的事件接线处理；后台槽在这里记阶段与账
    const trace = traceOf(runtimeId);
    if (ev.type === "agent_start") trace.phase("started");
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      trace.phase("first_token");
    }
    if (ev.type === "tool_execution_start") trace.phase("tool_start", { tool: ev.toolName });
    if (ev.type === "tool_execution_end") {
      trace.phase("tool_end", { tool: ev.toolName, ok: !ev.isError });
    }
    if (ev.type === "agent_settled") {
      invalidateStats(runtimeId);
      void updateBudget(runtimeId);
      trace.settle();
    }
  }
  send("pi:event", { ...ev, runtimeId } as unknown as PiStreamItem);
}

/**
 * pi 进程“已启动”与“已响应”不是一回事：spawn 成功只代表进程起来了，
 * 扩展加载/首次编译期间 RPC 可能几十秒不响应。这里以第一次成功响应为准，
 * 未就绪时 prompt 直接返回可读错误，而不是让预算查询干等 30 秒。
 */
let piReady = false;
let piProbeTimer: NodeJS.Timeout | null = null;
let piProbeAttempts = 0;

function setPiReady(next: boolean): void {
  if (piReady === next) return;
  piReady = next;
  console.log("[pi] ready=" + next);
  send("bridge:pi-ready", next);
}

function stopPiProbe(): void {
  if (piProbeTimer) {
    clearTimeout(piProbeTimer);
    piProbeTimer = null;
  }
}

function startPiProbe(): void {
  stopPiProbe();
  piProbeAttempts = 0;
  const tick = async (): Promise<void> => {
    piProbeTimer = null;
    if (piReady) return;
    piProbeAttempts += 1;
    try {
      await rpc.request({ type: "get_state" }, 1500);
      setPiReady(true);
      return;
    } catch (err) {
      if (piProbeAttempts <= 3) {
        console.log("[pi] probe fail #" + piProbeAttempts + ": " + (err instanceof Error ? err.message : String(err)));
      }
      if (piProbeAttempts >= 120) return; // 约 60 秒仍无响应，停止探测
      piProbeTimer = setTimeout(() => void tick(), 500);
      piProbeTimer.unref?.();
    }
  };
  const delayRaw = Number(process.env.OMCP_PI_PROBE_DELAY_MS ?? 300);
  const delay = Number.isFinite(delayRaw) ? Math.min(60_000, Math.max(0, delayRaw)) : 300;
  piProbeTimer = setTimeout(() => void tick(), delay);
  piProbeTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* 权限门：审批、授权、审计                                            */
/* ------------------------------------------------------------------ */

function auditFileAt(root: string | null): string | null {
  return root ? join(root, ".omcp", "logs", "audit.jsonl") : null;
}

function auditFile(): string | null {
  return auditFileAt(workspaceRoot);
}

/** P2b6b：后台 runtime 的审计写到它自己的 workspace */
const runtimeAuditLogs = new Map<string, AuditLog>();

function auditFor(runtimeId?: string): AuditLog | null {
  if (!runtimeId || runtimeId === "default") return auditLog;
  const runtime = runtimeManager.get(runtimeId);
  if (!runtime?.workspace) return auditLog;
  let log = runtimeAuditLogs.get(runtimeId);
  if (!log) {
    const root = runtime.workspace;
    log = new AuditLog(() => auditFileAt(root));
    runtimeAuditLogs.set(runtimeId, log);
  }
  return log;
}

function handleExtensionUi(
  ev: Extract<PiEvent, { type: "extension_ui_request" }>,
  targetRuntime: SessionRuntime = defaultRuntime,
): void {
  if (
    ev.method === "select" &&
    typeof ev.title === "string" &&
    ev.title.startsWith(APPROVAL_TITLE_PREFIX)
  ) {
    let payload: ApprovalTitlePayload | null = null;
    try {
      payload = JSON.parse(ev.title.slice(APPROVAL_TITLE_PREFIX.length)) as ApprovalTitlePayload;
    } catch {
      payload = null;
    }
    if (!payload || typeof payload.ruleId !== "string") {
      try {
        targetRuntime.rpc.sendRaw({ type: "extension_ui_response", id: ev.id, cancelled: true });
      } catch {
        // pi 已退出
      }
      return;
    }
    const rawTimeout = typeof ev.timeout === "number" ? ev.timeout : 120;
    const timeoutMs = Math.max(5_000, Math.min(rawTimeout * 1000, 600_000));
    const runtimeId =
      typeof (ev as unknown as { runtimeId?: unknown }).runtimeId === "string"
        ? (ev as unknown as { runtimeId: string }).runtimeId
        : targetRuntime.id;
    const request: ApprovalRequest = {
      id: ev.id,
      toolName: typeof payload.toolName === "string" ? payload.toolName : "unknown",
      ...(runtimeId ? { runtimeId } : {}),
      ruleId: payload.ruleId,
      summary: String(payload.summary ?? ""),
      options: [...APPROVAL_OPTIONS],
      timeoutMs,
      requestedAt: new Date().toISOString(),
    };
    const timer = setTimeout(() => resolveApproval(ev.id, "timeout"), timeoutMs);
    pendingApprovals.set(ev.id, {
      request,
      timer,
      sessionKey: targetRuntime.sessionFile ?? currentSessionFile ?? "session:none",
      runtimeId,
      rpc: targetRuntime.rpc,
      workspaceRoot: targetRuntime.workspace || workspaceRoot,
    });
    send("approval:request", request);
    return;
  }

  // 未识别的扩展 UI 请求：不阻塞 pi，直接取消
  try {
    rpc.sendRaw({ type: "extension_ui_response", id: ev.id, cancelled: true });
  } catch {
    // pi 已退出
  }
}

function resolveApproval(requestId: string, scope: ApprovalScope): void {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return;
  pendingApprovals.delete(requestId);
  clearTimeout(pending.timer);

  const allowed = scope === "once" || scope === "session" || scope === "always";
  const label = APPROVAL_OPTIONS.find((o) => o.value === scope)?.label ?? "拒绝";
  try {
    pending.rpc.sendRaw({ type: "extension_ui_response", id: requestId, value: label });
  } catch {
    // pi 已退出：审计仍然记录
  }

  if (allowed && grants) {
    if (scope === "session") {
      grants.grantSession(pending.workspaceRoot, pending.request.ruleId, pending.sessionKey);
    }
    if (scope === "always") {
      grants.grantPersistent(
        pending.workspaceRoot,
        pending.request.ruleId,
        appSettings.grantTtlDays,
      );
    }
  }

  auditFor(pending.runtimeId)?.write({
    ts: new Date().toISOString(),
    toolName: pending.request.toolName,
    ruleId: pending.request.ruleId,
    decision: scope === "timeout" ? "timeout" : allowed ? "allow" : "deny",
    scope,
    summary: pending.request.summary,
    sessionId: pending.sessionKey,
  });
  send("approval:resolved", { requestId, scope });
}

function cancelPendingApprovals(runtimeId?: string): void {
  for (const [id, pending] of [...pendingApprovals]) {
    if (runtimeId && pending.runtimeId !== runtimeId) continue;
    clearTimeout(pending.timer);
    pendingApprovals.delete(id);
    auditLog?.write({
      ts: new Date().toISOString(),
      toolName: pending.request.toolName,
      ruleId: pending.request.ruleId,
      decision: "deny",
      scope: "abort",
      summary: pending.request.summary,
      sessionId: pending.sessionKey,
    });
    send("approval:resolved", { requestId: id, scope: "deny" });
  }
}

function normalizeSessionFile(file: string | undefined | null): string | null {
  if (!file) return null;
  if (isAbsolute(file) && existsSync(file)) return file;
  const fromCwd = resolve(process.cwd(), file);
  if (existsSync(fromCwd)) return fromCwd;
  const fromDir = join(sessionDir, basename(file));
  if (existsSync(fromDir)) return fromDir;
  return isAbsolute(file) ? file : fromCwd;
}


function saveFigure(data: string): string | null {
  if (!workspaceRoot) return null;
  try {
    const dir = join(workspaceRoot, "figures");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    let file = join(dir, `fig-${stamp}.png`);
    let index = 1;
    while (existsSync(file)) {
      file = join(dir, `fig-${stamp}-${index++}.png`);
    }
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return null;
  }
}

function notebookPath(): string {
  if (!workspaceRoot) return join(app.getPath("userData"), "notebook.json");
  return join(workspaceRoot, ".omcp", "notebooks", "default.json");
}

/* ------------------------------------------------------------------ */
/* 模型注册表（P1）                                                    */
/* ------------------------------------------------------------------ */

/** 注册表文件放应用数据目录，不进工作区、不进仓库 */
/**
 * 某个槽/会话此刻的有效权限档（修改 4 · M2）。
 *
 * 改之前 `applyPermissionMode()` 往策略服务里塞一个全局值：切到另一段会话时
 * 那个值还是旧的，于是 A 的"完全访问"会影响 B。现在按会话现算。
 */
function permissionModeFor(ctx: { runtimeId?: string; sessionKey?: string }): PermissionMode {
  const file =
    ctx.sessionKey ?? (ctx.runtimeId ? runtimeManager.get(ctx.runtimeId)?.sessionFile ?? null : null);
  if (!file) return appSettings.permissionMode;
  const key = sessionMetaKey(file);
  // 修改六 · S3：会话可能住在**另一个工作区**。用视图的 workspaceRoot 去读，
  // 查不到就回落默认档——那个会话自己的设置等于没生效。
  const root = resolveSessionWorkspace(file) ?? workspaceRoot;
  if (!root) return appSettings.permissionMode;
  const override = key ? loadSessionMeta(root).sessions[key]?.permissionMode : undefined;
  return override ?? appSettings.permissionMode;
}

/** 当前会话单独设过的权限档；没有 = 跟随应用默认 */
function sessionPermissionOverride(): PermissionMode | null {
  if (!currentSessionFile) return null;
  const key = sessionMetaKey(currentSessionFile);
  if (!key) return null;
  const root = resolveSessionWorkspace(currentSessionFile) ?? workspaceRoot;
  if (!root) return null;
  return loadSessionMeta(root).sessions[key]?.permissionMode ?? null;
}

/**
 * 界面该看到的权限状态（修改六 · S2）。
 *
 * `effective` 走 `permissionModeFor()`——**和真正拦截用的是同一个函数**。
 * 以前这里取 `policyService.info().mode`（一个全局覆盖值），
 * 视图会话与上次 apply 的会话不一致时，界面会报一个并不生效的档。
 */
function permissionState(): PermissionState {
  return {
    effective: permissionModeFor({ sessionKey: currentSessionFile ?? undefined }),
    sessionOverride: sessionPermissionOverride(),
    default: appSettings.permissionMode,
  };
}

let permissionBroadcastTimer: NodeJS.Timeout | null = null;

/** 权限变了就推一条（30 ms 合并：切会话时可能连着 apply 两次） */
function broadcastPermission(source: "user" | "session" | "workspace"): void {
  if (permissionBroadcastTimer) return;
  permissionBroadcastTimer = setTimeout(() => {
    permissionBroadcastTimer = null;
    send("permission:changed", { ...permissionState(), source });
  }, 30);
  permissionBroadcastTimer.unref?.();
}

/**
 * 把权限档应用到策略服务：会话覆盖 > 应用默认 > 策略文件。
 * 切换会话、新建会话、改会话档、改默认档都要调一次——档位必须现取。
 */
function applyPermissionMode(source: "user" | "session" | "workspace" = "session"): void {
  policyService?.setMode(sessionPermissionOverride() ?? appSettings.permissionMode);
  broadcastPermission(source);
}


/**
 * P1b2b/c：给一个 runtime 注入它自己的服务 token。
 * 服务端已支持 runtime token；新 runtime 不能沿用默认 runtime 的 token。
 */
function applyRuntimeServiceEnv(runtime: SessionRuntime): void {
  runtime.setEnvs({
    OMCP_KERNEL_URL: kernelBroker?.url ?? "",
    OMCP_KERNEL_TOKEN: runtime.token,
    OMCP_POLICY_URL: policyService?.url ?? "",
    OMCP_POLICY_TOKEN: runtime.token,
    OMCP_ARTIFACTS_URL: artifactService?.url ?? "",
    OMCP_ARTIFACTS_TOKEN: runtime.token,
    OMCP_PLUGINS: JSON.stringify(enabledFamilyKeys(appSettings.plugins)),
    // 修改 4 · M4：子任务继承本槽的 provider/model（否则子进程用默认配置，可能指向被禁的模型）
    OMCP_PROVIDER: runtime.supervisor.getProvider(),
    OMCP_MODEL: runtime.supervisor.getModel(),
    // 修改 4 · M4：子任务并发闸 + 子 agent 名册位置
    OMCP_GATE_URL: subagentGateServer?.url ?? "",
    OMCP_GATE_TOKEN: subagentGateServer?.token ?? "",
    ...(() => {
      const dir = join(app.getPath("userData"), "agents");
      return { OMCP_AGENTS_DIR: dir };
    })(),
    OMCP_MEMORY_DIR: memoryDirPath(),
    ...(browserService
      ? { OMCP_BROWSER_URL: browserService.url, OMCP_BROWSER_TOKEN: browserService.token }
      : {}),
  });
}

function registryFile(): string {
  return join(app.getPath("userData"), "model-registry.json");
}

/** 与 piRuntimeInfo() 保持同一套解析：显式配置 > ~/.pi/agent */
function resolveAgentDir(): string {
  return appSettings.piConfigDir || join(app.getPath("home"), ".pi", "agent");
}

/**
 * MCP 服务按需创建：它读的配置目录、工作区、密钥都在启动后才稳定。
 * 状态检查会 spawn `pi mcp list --json`，入口解析与 supervisor 用同一套。
 */
function getMcpService(): McpService {
  mcpService ??= new McpService({
    agentDir: () => resolveAgentDir(),
    workspaceRoot: () => workspaceRoot || process.cwd(),
    secrets: () => secretStore,
    piEntry: () => {
      const resolved = resolvePi(
        process.env.OMCP_PI_PATH,
        (process as unknown as { resourcesPath?: string }).resourcesPath,
        process.env.OMCP_PI_DEV_ROOT,
      );
      if (resolved.kind === "error") return null;
      return { kind: resolved.kind, entry: resolved.entry };
    },
    trustFile: () => join(app.getPath("userData"), "mcp-trust.json"),
    onConfigSaved: () => {
      // 与插件开关同一套：重启 pi，下一段会话按新配置连接
      defaultRuntime.stop();
      setTimeout(() => defaultRuntime.start(), 300);
    },
  });
  return mcpService;
}

function piModelsPath(): string {
  return join(resolveAgentDir(), "models.json");
}

function readRegistry(): ModelRegistry {
  try {
    return validateRegistry(JSON.parse(readFileSync(registryFile(), "utf8"))).registry;
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(registry: ModelRegistry): { ok: boolean; error?: string } {
  try {
    const file = registryFile();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function hasProviderKey(id: string): boolean {
  return secretStore?.has(`provider:${id}:apiKey`) ?? false;
}

/** provider-catalog（随包只读）：内置 provider 的默认地址、模型与官方环境变量名 */
function catalogProviders(): CatalogProvider[] {
  return loadProviderCatalog(process.resourcesPath, app.getAppPath()).catalog?.providers ?? [];
}

function catalogProvider(id: string): CatalogProvider | null {
  return catalogProviders().find((p) => p.id === id) ?? null;
}

export type CredentialSource = "stored" | "env" | "auth" | "none";

/**
 * 凭据来源（P1-04）：安全存储 > 官方环境变量 > pi 的 auth.json > 无。
 * 只判断「有没有」，不读值、不打印值。
 */
function credentialStatus(id: string): { source: CredentialSource; has: boolean } {
  if (hasProviderKey(id)) return { source: "stored", has: true };
  if (hasEnvCredential(id, catalogProvider(id)?.envKeys)) return { source: "env", has: true };
  try {
    const file = join(resolveAgentDir(), "auth.json");
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (raw && typeof raw === "object" && id in raw) return { source: "auth", has: true };
    }
  } catch {
    // auth.json 读不出来就当没有；pi 自己会再判断
  }
  return { source: "none", has: false };
}

/**
 * 把密钥注入 pi 的环境变量。
 *
 * **同时注入两组名字**：pi-ai 为内置 provider 规定的官方变量名（DEEPSEEK_API_KEY…），
 * 以及我们自己的 OMCP_KEY_<ID>（供本应用生成的 models.json 用 `$OMCP_KEY_<ID>` 引用）。
 * 只注入官方名的话，models.json 引用会落空；只注入我们的名，内置 provider 不认。
 */
function applyRegistryEnv(): void {
  const registry = readRegistry();
  const ids = new Set<string>(Object.keys(registry.providers));
  // 不在配置层、但存过密钥的 provider（例如用户后来删了配置）也要能工作
  for (const key of secretStore?.keys() ?? []) {
    const m = /^provider:(.+):apiKey$/.exec(key);
    if (m?.[1]) ids.add(m[1]);
  }
  for (const id of ids) {
    const key = secretStore?.get(`provider:${id}:apiKey`);
    if (!key) continue;
    for (const name of credentialEnvNames(id, catalogProvider(id)?.envKeys)) {
      defaultRuntime.setEnv(name, key);
    }
  }
}

interface SyncResult {
  ok: boolean;
  written: boolean;
  backup?: string;
  warnings: string[];
  error?: string;
}

/**
 * 把注册表合并写进 pi 的 models.json。
 * 规则：只覆盖同名 provider，其它 provider 与顶层键原样保留；改前备份；内容没变不写。
 */
function catalogModelMeta(providerId: string, modelId: string): RegistryModel | undefined {
  const p = catalogProvider(providerId);
  if (!p) return undefined;
  return p.models.find((m) => m.id === modelId) as unknown as RegistryModel | undefined;
}

/**
 * 扫 models.json，找出把 apiKey 写成明文的 provider（PR4）。
 *
 * 只返回 provider id，不返回也不打印密钥；只提示，不自动迁移（已定的决定）。
 * `$ENV` / `!command` / `local` 都不算明文。
 */
function findPlaintextModelKeys(): string[] {
  const file = piModelsPath();
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, unknown> };
    const out: string[] = [];
    for (const [id, value] of Object.entries(raw.providers ?? {})) {
      const key = (value as { apiKey?: unknown } | null)?.apiKey;
      if (typeof key !== "string") continue;
      const trimmed = key.trim();
      if (!trimmed || trimmed === "local" || trimmed.startsWith("$") || trimmed.startsWith("!")) continue;
      out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

function syncRegistryToPi(reg?: ModelRegistry, removeIds: string[] = []): SyncResult {
  const registry = reg ?? readRegistry();
  const built = buildPiProviders(registry, hasProviderKey, catalogModelMeta);
  const warnings = built.skipped.map((s) => `${s.id}：${s.reason}`);
  // 没有可写项**且没有要删的**才提前返回；否则「删掉最后一个 provider」会留着 models.json 里的旧条目
  if (Object.keys(built.providers).length === 0 && removeIds.length === 0) {
    return { ok: true, written: false, warnings };
  }

  const file = piModelsPath();
  let existing: unknown;
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { ok: false, written: false, warnings, error: "现有 models.json 不是合法 JSON，未改动" };
    }
  }

  const merged = mergeModelsJson(existing, built.providers, removeIds);
  if (merged.error || !merged.next) {
    return { ok: false, written: false, warnings, error: merged.error ?? "合并失败" };
  }
  if (!merged.changed) return { ok: true, written: false, warnings };

  let backup: string | undefined;
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      backup = `${file}.bak-${stamp}`;
      copyFileSync(file, backup);
    }
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(merged.next, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
    return { ok: true, written: true, backup, warnings };
  } catch (err) {
    return { ok: false, written: false, warnings, error: (err as Error).message };
  }
}


/** 读会话文件前 256 KB，找第一条用户文本（回填标题用） */
function firstUserText(file: string): string | null {
  try {
    const head = readFileSync(file, "utf8").slice(0, 256 * 1024);
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const text = extractUserText(JSON.parse(line));
        if (text && text.trim()) return text;
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * 列会话（修改 5 · C6）：磁盘扫描交给 `SessionIndex`（异步 + 增量 + 只读头部），
 * 这里只负责把标题补上。
 *
 * 标题补全从热路径里拿出来了：它要读文件找第一句人话，一个没标题的老会话
 * 就是一次 256 KB 读盘。现在改成"先把列表给出去、后台补、下次刷新就有一个"。
 */
async function listSessions(
  dir: string | null = sessionDir,
  root: string = workspaceRoot,
): Promise<SessionSummary[]> {
  if (!dir) return [];
  mkdirSync(dir, { recursive: true });
  const out = await sessionIndex.list(dir);
  if (root) void backfillTitles(root, out);
  return out;
}

/** 给还没有标题的老会话补标题（后台、限量），写完进 meta，下次刷新就是它 */
function backfillTitles(root: string, sessions: SessionSummary[]): void {
  try {
    const meta = loadSessionMeta(root);
    const taken = Object.values(meta.sessions ?? {})
      .map((e) => e.title)
      .filter((t): t is string => Boolean(t));
    const autoTitles: Record<string, string> = {};
    let budget = 20; // 一次最多读 20 个文件，剩下的下次再说
    for (const item of sessions) {
      if (budget <= 0) break;
      const name = basename(item.sessionFile);
      const known = meta.sessions?.[name];
      if (known?.title || known?.renamed) continue;
      budget -= 1;
      const source = firstUserText(item.sessionFile);
      const base = source ? briefTitle(source) : null;
      if (!base) continue;
      const title = uniqueTitle(base, taken);
      taken.push(title);
      autoTitles[name] = title;
    }
    if (Object.keys(autoTitles).length) applyAutoTitles(root, autoTitles);
  } catch {
    // 补标题失败不影响列表
  }
}

interface PersistedState {
  lastSessionFile?: string | null;
  dailyDate?: string;
  dailySpent?: number;
  sessionCosts?: Record<string, number>;
}

function readState(): PersistedState {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as PersistedState;
  } catch {
    return {};
  }
}

function writeState(patch: Partial<PersistedState>): void {
  try {
    const next = { ...readState(), ...patch };
    writeFileSync(stateFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    // 不阻断主流程，但不能静默：写失败意味着重启后这份状态会回退
    console.warn("[state] 写入失败：" + (err as Error).message);
  }
}

interface WorkspacesState {
  lastWorkspace?: string;
  recent?: string[];
  /** 修改五：项目表（文件夹工作区）。老文件没有这一段，读取时按 recent 补齐 */
  projects?: ProjectRecord[];
}

function readWorkspaces(): WorkspacesState {
  try {
    return JSON.parse(readFileSync(workspacesFile, "utf8")) as WorkspacesState;
  } catch {
    return {};
  }
}

function writeWorkspaces(next: WorkspacesState): void {
  try {
    // 合并写：调用方只改 lastWorkspace/recent 时不能把 projects 冲掉
    let current: WorkspacesState = {};
    try {
      current = JSON.parse(readFileSync(workspacesFile, "utf8")) as WorkspacesState;
    } catch {
      current = {};
    }
    writeFileSync(
      workspacesFile,
      JSON.stringify({ ...current, ...next }, null, 2) + "\n",
      "utf8",
    );
  } catch (err) {
    console.warn("[workspaces] 写入失败：" + (err as Error).message);
  }
}

/** 临时会话的根（修改五）：应用数据目录下的 scratch，不算项目 */
function scratchRoot(): string {
  return join(app.getPath("userData"), "scratch");
}

function isScratchRoot(root: string): boolean {
  return sessionKey(root) === sessionKey(scratchRoot());
}

/** 读项目表：老数据按 recent 补齐，补完落盘一次 */
function readProjects(): ProjectRecord[] {
  const state = readWorkspaces();
  const { projects, changed } = normalizeProjects({
    ...(state.projects ? { projects: state.projects } : {}),
    recent: state.recent ?? [],
    scratchRoot: scratchRoot(),
    nowIso: new Date().toISOString(),
  });
  if (changed || !state.projects) writeWorkspaces({ projects });
  return projects;
}

function saveProjects(list: ProjectRecord[]): void {
  writeWorkspaces({ projects: list });
}

interface WorkspaceState {
  lastSessionFile?: string | null;
}

function readWorkspaceState(): WorkspaceState {
  try {
    return JSON.parse(readFileSync(workspaceStateFile, "utf8")) as WorkspaceState;
  } catch {
    return {};
  }
}

function writeWorkspaceState(patch: Partial<WorkspaceState>): void {
  try {
    const next = { ...readWorkspaceState(), ...patch };
    writeFileSync(workspaceStateFile, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (err) {
    console.warn("[workspace-state] 写入失败：" + (err as Error).message);
  }
}

const AGENTS_TEMPLATE = `# 项目约定

这是 oh-my-coding-pi 工作区。分析前请先读数据，不要凭文件名猜。

## 目录

- data/raw：只读
- data/processed：衍生数据
- analysis/scripts：分析脚本
- analysis/notebooks：notebook
- results/tables：结果表
- results/models：模型对象
- results/reports：报告
- figures：图

## 规则

1. 不修改 data/raw。
2. 写操作先说明目标路径。
3. 分析前说明假设与统计口径。
4. 图带轴标签与单位；表能追溯到脚本。
`;

function migrateSessions(destination: string): number {
  const legacy = join(app.getPath("userData"), "sessions");
  if (!existsSync(legacy)) return 0;
  const existing = readdirSync(destination).filter((f) => f.endsWith(".jsonl"));
  if (existing.length > 0) return 0;
  let copied = 0;
  for (const name of readdirSync(legacy)) {
    if (!name.endsWith(".jsonl")) continue;
    try {
      copyFileSync(join(legacy, name), join(destination, name));
      copied++;
    } catch {
      // skip broken files
    }
  }
  return copied;
}

/**
 * 可选：打开工作区后延迟预热当前语言的内核。
 * 默认关闭——只有显式设置 OMCP_KERNEL_PREWARM=python|r 才生效；
 * 没有实测数据证明冷启动占主导之前，不默认占用常驻内存。
 */
let prewarmTimer: NodeJS.Timeout | null = null;
function scheduleKernelPrewarm(): void {
  const want = process.env.OMCP_KERNEL_PREWARM;
  if (want !== "python" && want !== "r") return;
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    const target = want === "python" ? pythonKernel : rKernel;
    if (!target || !workspaceRoot) return;
    const t0 = Date.now();
    void target
      .ensureStarted()
      .then(() => console.log(`[kernel] prewarm ${want} ready in ${Date.now() - t0} ms`))
      .catch((err) =>
        console.warn(`[kernel] prewarm ${want} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  }, 3000);
  prewarmTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* 工作区视图（修改 5 · S1/S2）                                       */
/* ------------------------------------------------------------------ */

/**
 * 已知工作区根：当前视图 + 最近打开（去重、保持顺序）。
 *
 * 只在这几个根里认会话归属——从任意路径反推工作区，等于把一个没登记过的
 * 目录当成工作区，后续的文件树、策略、内核全会跟着错。
 */
function knownWorkspaceRoots(): string[] {
  // 修改五：scratch 也算"登记过"的根——临时会话要能在那里新建/打开
  const roots = [workspaceRoot, scratchRoot(), ...(readWorkspaces().recent ?? [])]
    .map((root) => String(root ?? "").trim())
    .filter(Boolean);
  return [...new Set(roots)];
}

/**
 * 会话文件属于哪个工作区（修改 5 · C1）。
 *
 * 判据是**目录**而不是文件名：会话文件一定住在 `<工作区>/.omcp/sessions` 下。
 * 这不是“猜”，是 layout 的硬约束；猜不到就返回 null，由调用方回落当前视图。
 */
function resolveSessionWorkspace(file: string | null | undefined): string | null {
  return workspaceOfSession(normalizeSessionFile(file) ?? file, knownWorkspaceRoots());
}

/**
 * 只切视图（修改 5 · D1）：改的是「看哪儿」，不是「谁在跑」。
 *
 * 这里**不 stop 任何槽、不关别的工作区的槽、不等进程退出**——
 * 那三件事原来是 `openWorkspace` 干的，也是「切过去很慢 + 开不了新对话」的根。
 * 返回是否真的换了工作区（同根重复打开是幂等的）。
 */
function activateWorkspaceView(root: string): boolean {
  const resolved = resolve(root);
  if (sessionKey(resolved) === sessionKey(workspaceRoot)) return false;
  workspaceRoot = resolved;
  sessionDir = sessionsDirOf(resolved);
  workspaceStateFile = join(resolved, ".omcp", "state.json");
  policyService?.reload();
  invalidateWorkspaceIndex();
  sessionListCache.clear();
  return true;
}

/** 默认槽是否就是这个工作区的（cwd 建进程那刻焊死，只能按 workspace 判） */
function defaultSlotInWorkspace(root: string): boolean {
  return sessionKey(defaultRuntime.workspace) === sessionKey(root);
}

/** 等默认槽真的退下去（taskkill 是异步的；不等就会新旧两个进程重叠） */
async function waitDefaultStop(timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (defaultRuntime.isRunning && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * 让默认槽服务于当前视图（修改 5 · S2）。
 *
 * - 已在同一工作区：什么都不做（幂等）；
 * - 在别的工作区但正忙：**不动它**，那个工作区的任务继续跑，
 *   新建会话交给槽池另起一个槽；
 * - 在别的工作区且空闲：停掉它、按新工作区重新拉起（会话已落盘，"停"不等于"丢"）。
 */
async function ensureDefaultSlotForView(root: string): Promise<void> {
  if (defaultRuntime.isRunning) {
    if (defaultSlotInWorkspace(root)) return;
    if (defaultRuntime.busy) return;
    defaultRuntime.stop();
    await waitDefaultStop();
  }
  defaultRuntime.setWorkspace(root);
  defaultRuntime.setSessionDir(sessionsDirOf(root));
  defaultRuntime.setTrustProject(appSettings.trustProject);
  defaultRuntime.setSessionFile(currentSessionFile);
  slotPool.bindSession("default", currentSessionFile);
  defaultRuntime.start();
}

/**
 * 给「新建会话」找一个槽（修改 5 · C4）。
 *
 * 新会话还没有文件名，所以不能走 `slotPool.open`（那个入口需要先有文件）。
 * 顺序：同工作区里就绪且空着的槽 → 同工作区里已挂起且空着的槽 → 新建一个。
 * 全程不碰别的工作区的槽；满员时由 `spawnFree` 按准入规则挂起最久未用的空闲槽。
 */
async function acquireSlotForNewSession(workspace: string): Promise<SessionRuntime> {
  const sameWorkspace = (slot: SessionRuntime): boolean =>
    sessionKey(slot.workspace) === sessionKey(workspace);
  const pool = slotPool
    .list()
    .map((info) => slotPool.get(info.id))
    .filter((slot): slot is SessionRuntime => Boolean(slot) && sameWorkspace(slot as SessionRuntime));

  const ready = pool.find((slot) => slot.isRunning && slot.ready && !slot.sessionFile);
  const suspended = pool.find((slot) => !slot.isRunning && !slot.sessionFile);
  const target =
    ready ??
    suspended ??
    slotPool.spawnFree(workspace, { visibleSlotId: slotPool.activeSlotId });
  if (!target.isRunning) {
    target.setSessionDir(sessionsDirOf(workspace));
    target.start();
  }
  await target.waitReady(45_000);
  return target;
}

/**
 * 打开（或新加）一个工作区。
 *
 * 修改 5 起这是**非破坏性**的：先建目录、再切视图、最后只为这个工作区
 * 准备一个默认槽。别的槽、别的会话、正在跑的回合一律不受影响。
 */
async function openWorkspace(root: string): Promise<WorkspaceOpenResult> {
  const t = switchTiming.begin("workspace-open");
  const resolved = resolve(root);
  mkdirSync(resolved, { recursive: true });

  const science = join(resolved, ".omcp");
  for (const dir of ["sessions", "logs", "notebooks", "figures"]) {
    mkdirSync(join(science, dir), { recursive: true });
  }
  for (const dir of [
    "data/raw",
    "data/processed",
    "analysis/scripts",
    "analysis/notebooks",
    "results/tables",
    "results/models",
    "results/reports",
    "figures",
  ]) {
    mkdirSync(join(resolved, dir), { recursive: true });
  }
  const agents = join(resolved, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(agents, AGENTS_TEMPLATE, "utf8");
  }

  const newSessionDir = sessionsDirOf(resolved);
  const migratedSessions = migrateSessions(newSessionDir);
  if (migratedSessions > 0) sessionIndex.invalidate(newSessionDir);
  switchTiming.mark(t, "layout");

  // 只换视图指针：不 stop、不关槽、不等 350 ms
  activateWorkspaceView(resolved);
  switchTiming.mark(t, "view");

  const wsState = readWorkspaceState();
  const last = wsState.lastSessionFile ?? null;
  currentSessionFile = last && existsSync(last) ? last : null;
  applyPermissionMode("workspace");
  pointKernelsAt(currentSessionFile);
  scheduleKernelPrewarm();

  let provider = appSettings.provider;
  let model = appSettings.model;
  try {
    const wsSettings = JSON.parse(
      readFileSync(join(science, "settings.json"), "utf8"),
    ) as { provider?: string; model?: string };
    if (typeof wsSettings.provider === "string") provider = wsSettings.provider;
    if (typeof wsSettings.model === "string") model = wsSettings.model;
  } catch {
    // defaults
  }
  defaultRuntime.setModel(provider, model);
  defaultRuntime.setThinkingLevel(appSettings.thinkingLevel);
  try {
    writeFileSync(
      join(science, "workspace.json"),
      JSON.stringify({ root: resolved, trusted: true, openedAt: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // ignore
  }

  // 每次打开工作区/启动都重建一次 models.json：
  // pi 自己也会写这个文件（远端目录缓存），不重建就可能某天发现我们的条目没了。
  applyRegistryEnv();
  {
    const reg = readRegistry();
    const stale = (reg.managed ?? []).filter((id) => !(id in reg.providers));
    syncRegistryToPi(reg, stale);
  }

  // 默认槽：同一工作区就复用；别的工作区里空闲就重新拉起；正忙就留给它跑
  await ensureDefaultSlotForView(resolved);
  switchTiming.mark(t, "default-slot", { running: defaultRuntime.isRunning });

  const all = readWorkspaces();
  const recent = [resolved, ...(all.recent ?? []).filter((x) => x !== resolved)].slice(0, 8);
  writeWorkspaces({ lastWorkspace: resolved, recent });
  // 修改五：打开一个文件夹就是一"项目"（scratch 除外）
  if (!isScratchRoot(resolved)) {
    saveProjects(upsertProject(readProjects(), resolved, new Date().toISOString()));
  }
  send("workspace:changed", { root: resolved, recent } satisfies WorkspaceInfo);

  setTimeout(() => void resetBudgetBaseline("default"), 1500);
  switchTiming.end(t, { migrated: migratedSessions });
  return { root: resolved, initialized: true, migratedSessions };
}

function saveAppSettings(): void {
  try {
    const existing = existsSync(settingsFile)
      ? (JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>)
      : {};
    existing.grantTtlDays = appSettings.grantTtlDays;
    existing.readonlyNotebook = appSettings.readonlyNotebook;
    existing.provider = appSettings.provider;
    existing.model = appSettings.model;
    existing.pythonPath = appSettings.pythonPath;
    existing.rPath = appSettings.rPath;
    existing.updateRepo = appSettings.updateRepo;
    existing.trustProject = appSettings.trustProject;
    existing.visionBaseUrl = appSettings.visionBaseUrl;
    existing.visionModel = appSettings.visionModel;
    existing.piConfigDir = appSettings.piConfigDir;
    existing.sessionLimit = appSettings.sessionLimit;
    existing.dailyLimit = appSettings.dailyLimit;
    existing.plugins = appSettings.plugins;
    existing.permissionMode = appSettings.permissionMode;
    existing.thinkingLevel = appSettings.thinkingLevel;
    existing.maxRuntimes = appSettings.maxRuntimes;
    existing.runtimeIdleMinutes = appSettings.runtimeIdleMinutes;
    writeFileSync(settingsFile, JSON.stringify(existing, null, 2) + "\n", "utf8");
  } catch (err) {
    // 保存失败不阻断；但要让日志里留下痕迹，否则用户会以为设置已生效
    console.error("[settings] 写入失败，下次启动将用旧值：" + (err as Error).message);
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadSettings(): void {
  try {
    const data = JSON.parse(readFileSync(settingsFile, "utf8")) as {
      budget?: Partial<typeof budget>;
      policyPath?: string;
      grantTtlDays?: number;
      readonlyNotebook?: boolean;
      provider?: string;
      model?: string;
      pythonPath?: string;
      rPath?: string;
      updateRepo?: string;
      trustProject?: boolean;
      visionBaseUrl?: string;
      visionModel?: string;
      piConfigDir?: string;
      sessionLimit?: number;
      dailyLimit?: number;
      plugins?: Record<string, unknown>;
      permissionMode?: unknown;
      thinkingLevel?: unknown;
      maxRuntimes?: number;
      runtimeIdleMinutes?: number;
    };
    if (typeof data.policyPath === "string" && data.policyPath.trim()) {
      settingsPolicyPath = data.policyPath.trim();
    }
    if (typeof data.grantTtlDays === "number" && Number.isFinite(data.grantTtlDays)) {
      appSettings.grantTtlDays = Math.max(0, Math.min(3650, Math.floor(data.grantTtlDays)));
    }
    if (typeof data.readonlyNotebook === "boolean") {
      appSettings.readonlyNotebook = data.readonlyNotebook;
    }
    if (typeof data.provider === "string" && data.provider.trim()) appSettings.provider = data.provider.trim();
    if (typeof data.model === "string" && data.model.trim()) appSettings.model = data.model.trim();
    if (typeof data.pythonPath === "string") appSettings.pythonPath = data.pythonPath.trim();
    if (typeof data.rPath === "string") appSettings.rPath = data.rPath.trim();
    if (typeof data.updateRepo === "string") appSettings.updateRepo = data.updateRepo.trim();
    if (typeof data.trustProject === "boolean") appSettings.trustProject = data.trustProject;
    if (typeof data.visionBaseUrl === "string") appSettings.visionBaseUrl = data.visionBaseUrl.trim();
    if (typeof data.visionModel === "string") appSettings.visionModel = data.visionModel.trim();
    if (typeof data.piConfigDir === "string") appSettings.piConfigDir = data.piConfigDir.trim();
    if (typeof data.sessionLimit === "number") appSettings.sessionLimit = data.sessionLimit;
    if (typeof data.dailyLimit === "number") appSettings.dailyLimit = data.dailyLimit;
    if (
      data.permissionMode === "deny-risky" ||
      data.permissionMode === "ask-risky" ||
      data.permissionMode === "allow-all"
    ) {
      appSettings.permissionMode = data.permissionMode;
    }
    if (typeof data.maxRuntimes === "number" && Number.isFinite(data.maxRuntimes)) {
      appSettings.maxRuntimes = Math.max(1, Math.min(4, Math.floor(data.maxRuntimes)));
    }
    if (
      typeof data.runtimeIdleMinutes === "number" &&
      Number.isFinite(data.runtimeIdleMinutes)
    ) {
      appSettings.runtimeIdleMinutes = Math.max(1, Math.min(1440, Math.floor(data.runtimeIdleMinutes)));
    }
    if (isThinkingLevel(data.thinkingLevel)) {
      appSettings.thinkingLevel = data.thinkingLevel;
    }
    if (data.plugins && typeof data.plugins === "object") {
      // 只认插件册里登记过的键，且只接受 "0"/"1"：旧版本多出来的键直接丢弃
      const known = new Set(Object.keys(defaultFlags()));
      for (const [key, value] of Object.entries(data.plugins)) {
        if (!known.has(key)) continue;
        appSettings.plugins[key] = value === "1" ? "1" : "0";
      }
    }
    if (data.budget) {
      if (typeof data.budget.sessionLimit === "number") budget.sessionLimit = data.budget.sessionLimit;
      if (typeof data.budget.dailyLimit === "number") budget.dailyLimit = data.budget.dailyLimit;
      if (typeof data.budget.alertRatio === "number") budget.alertRatio = data.budget.alertRatio;
    }
  } catch {
    // defaults
  }
}

/**
 * 会话统计：同一时刻只允许一个 get_session_stats 在飞，结果缓存 250 ms。
 * - 展示路径（footer、budget、上下文仪表）共用这一份，回合末 4 次调用收敛成 1 次；
 * - 发送前的预算判断用 getStats(true) 强制取权威值，缓存不能放行超预算的请求；
 * - 收到 usage/entry_appended/agent_settled 或切会话时立刻失效。
 */
/**
 * 每个槽一份统计缓存（修改 4 · M2）。
 *
 * 改之前只有一个 `rpc`（默认槽）的缓存与单飞：于是**预算门量的是默认会话的钱**，
 * 后台会话烧多少都不拦，而默认会话一旦超限会把所有会话一起拦住。
 */
interface SlotStatsCache {
  at: number;
  value: SessionStats;
  gen: number;
}
const statsBySlot = new Map<
  string,
  { cache: SlotStatsCache | null; gen: number; inFlight: { gen: number; p: Promise<SessionStats> } | null }
>();
/** 自上次 prompt 以来实际发出的 get_session_stats 次数（验证 4→1） */
let statsQueryCount = 0;

function statsSlot(runtimeId: string) {
  let slot = statsBySlot.get(runtimeId);
  if (!slot) {
    slot = { cache: null, gen: 0, inFlight: null };
    statsBySlot.set(runtimeId, slot);
  }
  return slot;
}

/** 失效：给 id 就只失效那一个，不给就全失效 */
function invalidateStats(runtimeId?: string): void {
  if (runtimeId) {
    const slot = statsSlot(runtimeId);
    slot.cache = null;
    slot.gen += 1;
    return;
  }
  for (const slot of statsBySlot.values()) {
    slot.cache = null;
    slot.gen += 1;
  }
}

function runtimeById(runtimeId: string): SessionRuntime | undefined {
  return runtimeId === "default" ? defaultRuntime : runtimeManager.get(runtimeId);
}

/** 这一轮默认的统计超时；非默认槽给 10 秒，别让预算门干等 */
function statsTimeout(runtimeId: string): number {
  if (runtimeId !== "default") return 10_000;
  return piReady ? 30_000 : 3_000;
}

async function getStatsFor(
  runtimeId: string,
  force = false,
  timeoutMs = statsTimeout(runtimeId),
): Promise<SessionStats> {
  const runtime = runtimeById(runtimeId);
  if (!runtime) throw new Error(`没有这个槽：${runtimeId}`);
  const slot = statsSlot(runtimeId);
  const now = Date.now();
  if (!force) {
    if (slot.cache && slot.cache.gen === slot.gen && now - slot.cache.at < 250) {
      return slot.cache.value;
    }
    if (slot.inFlight && slot.inFlight.gen === slot.gen) return slot.inFlight.p;
  }
  const gen = slot.gen;
  statsQueryCount += 1;
  const run = (async () => {
    const res = await runtime.rpc.request({ type: "get_session_stats" }, timeoutMs);
    const value = res.data as SessionStats;
    if (gen === slot.gen) slot.cache = { at: Date.now(), value, gen };
    return value;
  })();
  if (force) return run; // 预算门不排队、不复用可能早于最新 usage 的飞行请求
  slot.inFlight = { gen, p: run };
  void run
    .finally(() => {
      if (slot.inFlight?.gen === gen) slot.inFlight = null;
    })
    .catch(() => {
      // 调用方各自处理错误；这里只负责清理飞行状态，避免未处理拒绝
    });
  return run;
}

/** 兼容旧的调用点：默认槽的统计 */
function getStats(force = false, timeoutMs?: number): Promise<SessionStats> {
  return getStatsFor("default", force, timeoutMs);
}

function reportError(error: AppError): void {
  send("bridge:error", error);
  try {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(
      join(logsDir, "app.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        ...error,
        session: currentSessionFile ? basename(currentSessionFile) : null,
      }) + "\n",
      "utf8",
    );
  } catch {
    // logging must never break the app
  }
}

function ledgerState() {
  return { dailyDate, dailySpent, sessionCosts };
}

function budgetStatus(cost: number, sessionFile: string | null): BudgetStatus {
  return budgetStatusOf({ cost, sessionFile, ledger: ledgerState(), limits: budget });
}

/** 已经就"接近上限"提醒过的会话（原来是全局一个 flag） */
const alertedSessions = new Set<string>();
/** 日额度提醒的"已报过"标记：`<日期>:<档位>`，跨天由 rollover 清掉 */
const alertedBands = new Set<string>();

async function refreshBudget(runtimeId = slotPool.activeSlotId ?? "default"): Promise<BudgetStatus> {
  const file = runtimeById(runtimeId)?.sessionFile ?? null;
  try {
    const stats = await getStatsFor(runtimeId);
    return budgetStatus(stats.cost ?? 0, file);
  } catch {
    return budgetStatus(0, file);
  }
}

/**
 * 记账：把某个槽这次的费用增量记到**它自己的会话**名下。
 *
 * 日账是账号级的（所有会话共用），所以 `dailySpent` 仍是一个数；
 * 会话账按文件分，这也是 ADR-017 的口径。
 */
/**
 * 日额度的两档提醒（修改 5 · D1：后台会话照常烧 token，所以要出声）。
 *
 * 三件事刻意这么做：
 *  - **按档位去重**，不按会话：一天只响两次（80% / 100%），而不是每个会话响一遍；
 *  - **说出是谁烧的**：切走之后用户看不到那个会话，只知道"额度没了"没法判断；
 *  - **不自动停槽**：停槽会丢掉正在飞的一轮，停不停是人的决定。
 */
function maybeReportDailyBudget(
  status: BudgetStatus,
  runtimeId: string,
  sessionFile: string | null,
): void {
  const limit = budget.dailyLimit;
  if (!(limit > 0)) return;
  const ratio = status.dailyUsd / limit;
  const band = ratio >= 1 ? 100 : ratio >= budget.alertRatio ? Math.round(budget.alertRatio * 100) : 0;
  if (!band) return;
  const key = `${dailyDate}:${band}`;
  if (alertedBands.has(key)) return;
  alertedBands.add(key);
  const where = sessionFile ? basename(sessionFile) : runtimeId;
  const visible = Boolean(
    sessionFile && currentSessionFile && sessionKey(sessionFile) === sessionKey(currentSessionFile),
  );
  reportError({
    code: band >= 100 ? "E_BUDGET_DAILY" : "E_BUDGET_NEAR",
    severity: band >= 100 ? "error" : "warning",
    title: band >= 100 ? "今日额度已用完" : `今日额度已用 ${Math.round(ratio * 100)}%`,
    detail:
      `今日 $${status.dailyUsd.toFixed(2)}/$${limit} · 这一段来自${visible ? "当前会话" : "后台会话"}（${where}）。` +
      "后台会话不会自动停，需要时手动停止。",
    recoverable: true,
    action: "none",
  });
}

async function updateBudget(runtimeId: string): Promise<void> {
  const runtime = runtimeById(runtimeId);
  const sessionFile = runtime?.sessionFile ?? null;
  try {
    const stats = await getStatsFor(runtimeId);
    const cost = stats.cost ?? 0;
    const applied = applyCost({ cost, sessionFile, ledger: ledgerState(), today: todayISO() });
    dailyDate = applied.ledger.dailyDate;
    dailySpent = applied.ledger.dailySpent;
    sessionCosts = applied.ledger.sessionCosts;
    if (sessionFile || applied.rollover) {
      writeState({ dailyDate, dailySpent, sessionCosts });
    }

    const status = budgetStatus(cost, sessionFile);
    // 跨天：两套提醒都重新开始
    if (applied.rollover) {
      alertedSessions.clear();
      alertedBands.clear();
    }
    // 会话账：这一段自己接近上限（一次会话只提醒一次）
    if (
      sessionFile &&
      !alertedSessions.has(sessionFile) &&
      status.sessionUsd >= budget.sessionLimit * budget.alertRatio
    ) {
      alertedSessions.add(sessionFile);
      reportError({
        code: "E_BUDGET",
        severity: "warning",
        title: "会话预算接近上限",
        detail: `这段会话 $${status.sessionUsd.toFixed(4)}/$${status.sessionLimit} · 今日 $${status.dailyUsd.toFixed(4)}/$${status.dailyLimit}`,
        recoverable: true,
        action: "none",
      });
    }
    // 日账：全局一条，80% 与 100% 各一次——后台会话烧的也算进来（修改 5 · D1）
    maybeReportDailyBudget(status, runtimeId, sessionFile);
  } catch {
    // ignore
  }
}

async function resetBudgetBaseline(runtimeId = "default"): Promise<void> {
  const runtime = runtimeById(runtimeId);
  const sessionFile = runtime?.sessionFile ?? null;
  if (sessionFile) alertedSessions.delete(sessionFile);
  try {
    const stats = await getStatsFor(runtimeId);
    if (sessionFile) {
      sessionCosts[sessionFile] = stats.cost ?? 0;
      writeState({ sessionCosts });
    }
  } catch {
    // ignore
  }
}

/**
 * pi 拒绝 prompt 时把原文带回去：以前只返回布尔，界面上只剩“消息未被接受”，
 * 真正原因（例如 No API key found for deepseek）被丢掉。同时写一条 app.jsonl。
 */
function promptResult(res: { success: boolean; error?: string }): PromptResult {
  if (res.success) return { ok: true };
  const error = String(res.error ?? "").trim() || "pi 未说明原因";
  reportError({
    code: "E_PI_PROMPT",
    severity: "error",
    title: "消息未被 pi 接受",
    detail: "pi 拒绝了这条消息",
    raw: error,
    recoverable: true,
    action: "none",
  });
  return { ok: false, error };
}

/**
 * 发话前的预算门（修改 4 · M2）：量的是**这个槽/这段会话**的钱。
 *
 * 日账仍是账号级的——一天烧超了，所有会话都该停，这是有意的。
 */
async function checkBudget(target: SessionRuntime | { id: string; sessionFile: string | null }): Promise<boolean> {
  const runtimeId = "id" in target ? target.id : "default";
  const sessionFile = target.sessionFile;
  try {
    const stats = await getStatsFor(runtimeId, true);
    const status = budgetStatus(stats.cost ?? 0, sessionFile);
    if (status.sessionUsd >= status.sessionLimit) {
      reportError({
        code: "E_BUDGET",
        severity: "error",
        title: "会话预算已用完",
        detail: `本会话 $${status.sessionUsd.toFixed(4)}，上限 $${status.sessionLimit}。可在 settings.json 调整。`,
        recoverable: true,
        action: "none",
      });
      return false;
    }
    if (status.dailyUsd >= status.dailyLimit) {
      reportError({
        code: "E_BUDGET",
        severity: "error",
        title: "今日预算已用完",
        detail: `今日 $${status.dailyUsd.toFixed(4)}，上限 $${status.dailyLimit}。明天或调整 settings.json。`,
        recoverable: true,
        action: "none",
      });
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function clearAbortTimer(): void {
  if (abortTimer) {
    clearTimeout(abortTimer);
    abortTimer = null;
  }
}

/**
 * 修改 4 · M0：界面要的那张表（会话 + 槽）。
 *
 * 会话是身份，槽是进程；`active` 按槽算——因为"哪一段在屏幕上"这件事
 * 只有槽（进程）知道。
 */
function sessionBoard(): SessionBoardView {
  const queued = new Map(slotPool.queuePositions().map((item) => [sessionKey(item.file), item.position]));
  // 修改 5 · D1：**不按当前视图过滤**。标签要能显示另一个工作区里还在跑的会话，
  // 过滤掉的话它会被画成"已挂起"，而它的槽其实活得好好的。
  // 侧栏按工作区分组是界面自己的事（它走 `sessions:list-in`），不靠这张表。
  const sessions = sessionRegistry.list().map((record): SessionView => {
    const slot = record.slotId ? slotPool.get(record.slotId) : undefined;
    return {
      key: record.key,
      file: record.file,
      workspace: record.workspace,
      ...(record.title ? { title: record.title } : {}),
      state: record.state,
      ...(record.busySince !== undefined ? { busySince: record.busySince } : {}),
      // 未读以转录中枢为准（渲染端刷新后仍准）
      unread: transcriptHub.summary(hubKeyForFile(record.file)).unread,
      slotId: record.slotId,
      running: Boolean(slot?.isRunning),
      busy: Boolean(slot?.busy),
      active: record.slotId !== null && record.slotId === slotPool.activeSlotId,
      ...(queued.has(record.key) ? { queued: queued.get(record.key) } : {}),
    };
  });
  return {
    sessions,
    slots: slotPool.list(),
    activeSlotId: slotPool.activeSlotId,
    maxSlots: slotPool.max,
  };
}

/**
 * 把笔记本用的 `pythonKernel` / `rKernel` 指到**当前可见会话**的那一对（M2）。
 *
 * 这两个变量以前是全局单例（切会话就串台）。现在它们只是"别名的指针"：
 * 真正的归属在 `kernelManager` 里按会话记，指针指错了只是界面显示错，
 * 不会影响 run_code 走 broker 的那条路（那条按 token → 会话解析）。
 */
function pointKernelsAt(sessionFile: string | null): void {
  if (!kernelManager) return;
  const key = kernelKeyFor(sessionFile, slotPool?.activeSlotId ?? "default");
  const pair = kernelManager.get(key, workspaceRoot);
  pythonKernel = pair.python;
  rKernel = pair.r;
}

/**
 * 内核空闲多久算过期（M2）：默认 10 分钟，`OMCP_KERNEL_IDLE_MINUTES` 可调。
 * 内核比 pi 进程贵（100–300 MB），但变量是会话的资产，所以给一个明确、可解释的期限。
 */
function kernelIdleMs(): number {
  const minutes = Number(process.env.OMCP_KERNEL_IDLE_MINUTES ?? 10);
  return Math.max(1, Number.isFinite(minutes) ? minutes : 10) * 60_000;
}

/** 默认槽换绑会话：supervisor 的 `--session`、ServiceHub、会话登记表三处一起改 */
function bindDefaultSession(file: string | null): void {
  runtimeManager.updateSession("default", file);
  slotPool.bindSession("default", file);
}

/** 会话标记成忙碌/空闲（事件流里改，界面据此画状态点） */
function markSessionFromEvent(runtimeId: string, busy: boolean): boolean {
  const slot = slotPool.get(runtimeId);
  const file = slot?.sessionFile;
  if (!file) return false;
  const record = sessionRegistry.get(file);
  if (!record) return false;
  const next = busy ? "busy" : "idle";
  if (record.state === next) return false;
  // 修改 5 · D1：顺带记下这一轮的起点，标签据此显示「后台运行中 · 3:12」
  sessionRegistry.setBusy(file, busy);
  return true;
}

async function syncCurrentSession(): Promise<void> {
  try {
    const res = await rpc.request({ type: "get_state" });
    const state = res.data as SessionState | undefined;
    const file = normalizeSessionFile(state?.sessionFile);
    if (file) {
      currentSessionFile = file;
      bindDefaultSession(file);
      if (existsSync(file)) writeWorkspaceState({ lastSessionFile: file });
    }
  } catch {
    // ignore
  }
}

supervisor.on("spawn", (proc) => {
  rpc.attach(proc);
  setPiReady(false);
  startPiProbe();
});
supervisor.on("exit", (info: { code: number | null; signal: NodeJS.Signals | null }) => {
  setPiReady(false);
  stopPiProbe();
  rpc.detach();
  cancelPendingApprovals("default");
  grants?.clearSession();
  turnTrace.abort("pi-exit");
  eventPump.dispose();
  markSlotCrash("default");
  if (!supervisor.isStopping && info.code !== 0) {
    reportError({
      code: "E_PI_EXIT",
      severity: "error",
      title: "pi 进程已断开",
      detail: "pi 意外退出，正在恢复当前会话",
      raw: `exit code ${info.code ?? "null"}${info.signal ? " signal " + info.signal : ""}`,
      recoverable: true,
      action: "restart-pi",
    });
  }
});
supervisor.on("status", (status: BridgeStatus) => send("bridge:status", status));
supervisor.on(
  "version",
  (info: { actual: string | null; expected: string | null; ok: boolean; origin: string }) => {
    if (info.ok) return;
    reportError({
      code: "E_PI_SPAWN",
      severity: "warning",
      title: "pi 版本与期望不一致",
      detail: `实际 ${info.actual ?? "未知"}，期望 ${info.expected ?? "未知"}（来源 ${info.origin}）`,
      recoverable: true,
      action: "none",
    });
  },
);
supervisor.on("error", (err: Error) => {
  console.error("[supervisor]", err.message);
  reportError({
    code: "E_PI_SPAWN",
    severity: "fatal",
    title: "无法启动 pi",
    detail: "pi 入口不可用",
    raw: err.message,
    recoverable: true,
    action: "open-settings",
  });
  send("bridge:status", "error" satisfies BridgeStatus);
});

rpc.on("response", () => {
  // 默认槽也走同一份就绪判定：槽表据此给界面画状态点
  defaultRuntime.markReady();
  setPiReady(true);
});

rpc.on("event", (ev: PiEvent) => {
  turnTrace.countIpc();
  if (ev.type === "message_end" || ev.type === "entry_appended") invalidateStats();
  if (ev.type === "agent_start") turnTrace.phase("started");
  if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
    turnTrace.phase("first_token");
  }
  if (ev.type === "tool_execution_start") turnTrace.phase("tool_start", { tool: ev.toolName });
  if (ev.type === "tool_execution_end") {
    turnTrace.phase("tool_end", { tool: ev.toolName, ok: !ev.isError });
  }
  if (
    tokenProbe &&
    ev.type === "message_update" &&
    ev.assistantMessageEvent?.type === "text_delta" &&
    ev.assistantMessageEvent.delta
  ) {
    tokenProbe.resolve(Date.now() - tokenProbe.startedAt);
    tokenProbe = null;
  }
  if (ev.type === "extension_ui_request") {
    eventPump.flush();
    handleExtensionUi(ev);
    return;
  }
  eventPump.push(ev);
  if (ev.type === "agent_start") {
    void syncCurrentSession();
  }
  if (ev.type === "auto_retry_start") {
    const rate = /429|rate/i.test(ev.errorMessage);
    reportError({
      code: rate ? "E_MODEL_RATE" : "E_MODEL_NETWORK",
      severity: "warning",
      title: rate ? "模型限流，正在重试" : "正在重试",
      // 主行只给进度；技术原文进 raw，界面折叠显示（DAWN 的 failed-notice 结构）
      detail: `第 ${ev.attempt}/${ev.maxAttempts} 次，${Math.round(ev.delayMs / 100) / 10} 秒后重试`,
      raw: ev.errorMessage,
      recoverable: true,
      action: "retry",
    });
  }
  if (ev.type === "auto_retry_end" && !ev.success) {
    reportError({
      code: "E_MODEL_NETWORK",
      severity: "error",
      title: "模型服务仍不可用",
      detail: `已重试 ${ev.attempt} 次，仍无法连接`,
      raw: ev.finalError ?? `第 ${ev.attempt} 次尝试失败`,
      recoverable: true,
      action: "retry",
    });
  }
  if (ev.type === "extension_error") {
    reportError({
      code: "E_TOOL_ERROR",
      severity: "error",
      title: "扩展执行出错",
      detail: "扩展运行时出错",
      raw: ev.message,
      recoverable: true,
      action: "open-log",
    });
  }
  if (ev.type === "agent_settled") {
    clearAbortTimer();
    invalidateStats();
    turnTrace.settle();
    void syncCurrentSession();
    void updateBudget("default");
    const autoFinishModes = new Set(["", "tree", "fork", "clone", "export", "recover", "window"]);
    if (SELFTEST && autoFinishModes.has(SELFTEST_MODE) && !selftestDone) finishSelftest();
  }
});

async function finishSelftest(): Promise<void> {
  selftestDone = true;
  if (selftestTimer) clearTimeout(selftestTimer);
  setTimeout(async () => {
    try {
      if (SELFTEST_MODE === "window") {
        mkdirSync(screenshotsDir, { recursive: true });
        const image = await win!.webContents.capturePage();
        const file = join(screenshotsDir, "p1-window.png");
        writeFileSync(file, image.toPNG());
        console.log("P1_SELFTEST_WINDOW " + file);
      }
      if (SELFTEST_MODE === "tree") {
        await win!.webContents.executeJavaScript(
          "[...document.querySelectorAll('.side-tabs button')].find((b) => b.textContent === '树')?.click()",
        );
        await new Promise((r) => setTimeout(r, 700));
      }
      if (SELFTEST_MODE === "fork") {
        const tree = await win!.webContents.executeJavaScript("window.api.getTree()");
        const stack = [...(tree.tree ?? [])];
        let entryId: string | null = null;
        while (stack.length) {
          const node = stack.pop();
          if (node.entry?.message?.role === "user") {
            entryId = node.entry.id;
            break;
          }
          stack.push(...(node.children ?? []));
        }
        const res = entryId
          ? await win!.webContents.executeJavaScript(`window.api.fork(${JSON.stringify(entryId)})`)
          : { cancelled: true };
        console.log("P1_SELFTEST_FORK " + JSON.stringify(res));
        await new Promise((r) => setTimeout(r, 700));
      }
      if (SELFTEST_MODE === "clone") {
        const res = await win!.webContents.executeJavaScript("window.api.clone()");
        console.log("P1_SELFTEST_CLONE " + JSON.stringify(res));
        await new Promise((r) => setTimeout(r, 700));
      }
      if (SELFTEST_MODE === "export") {
        const path = await win!.webContents.executeJavaScript("window.api.exportHtml()");
        console.log("P1_SELFTEST_EXPORT " + JSON.stringify(path));
      }
      if (SELFTEST_MODE === "recover") {
        const before = await win!.webContents.executeJavaScript("window.api.getState()");
        await win!.webContents.executeJavaScript("window.api.restart()");
        await new Promise((r) => setTimeout(r, 3500));
        const after = await win!.webContents.executeJavaScript("window.api.getState()");
        const messages = await win!.webContents.executeJavaScript("window.api.getMessages()");
        console.log(
          "P1_SELFTEST_RECOVER " +
            JSON.stringify({
              before: before?.sessionFile,
              after: after?.sessionFile,
              messages: messages?.length ?? 0,
              same: before?.sessionFile === after?.sessionFile,
            }),
        );
      }
      const text = await win!.webContents.executeJavaScript("document.body.innerText");
      console.log("P1_SELFTEST_TEXT_START");
      console.log(text);
      console.log("P1_SELFTEST_TEXT_END");
      console.log("P1_SELFTEST_OK " + (/p1-ok/.test(text) ? "true" : "false"));
      if (SELFTEST_MODE === "window") {
        mkdirSync(screenshotsDir, { recursive: true });
        const image = await win!.webContents.capturePage();
        const file = join(screenshotsDir, "p1-window.png");
        writeFileSync(file, image.toPNG());
        console.log("P1_SELFTEST_WINDOW " + file);
      }
      if (SELFTEST_MODE === "tree") {
        console.log("P1_SELFTEST_TREE " + (/assistant/i.test(text) && /user/i.test(text) ? "true" : "false"));
      }
    } catch (err) {
      console.error("P1_SELFTEST_ERROR", err);
    } finally {
      app.quit();
    }
  }, 900);
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: !SELFTEST || SELFTEST_MODE === "window" || SELFTEST_MODE === "perflong",
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on("did-finish-load", () => {
    const autoPromptModes = new Set(["", "tree", "fork", "clone", "export", "recover", "window"]);
    if (!SELFTEST || !autoPromptModes.has(SELFTEST_MODE)) return;
    setTimeout(() => {
      rpc.send({ type: "prompt", message: "只回复：p1-ok" });
    }, 1800);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

let forceTextOnlyForTest = false;

async function describeForVision(
  data: string,
  mimeType: string,
): Promise<{ text: string | null; error?: string }> {
  if (!visionConfigured() || !secretStore) return { text: null, error: "未配置视觉服务" };
  const result = await describeImage(
    {
      baseUrl: appSettings.visionBaseUrl,
      model: appSettings.visionModel,
      apiKey: secretStore.get("vision:apiKey") ?? "",
    },
    data,
    mimeType,
  );
  return { text: result.ok ? (result.text ?? null) : null, error: result.error };
}

function visionConfigured(): boolean {
  return resolveVision() !== null;
}

async function modelSupportsImage(): Promise<boolean> {
  try {
    const state = (await rpc.request({ type: "get_state" }, 5000)).data as
      | SessionState
      | undefined;
    const model = state?.model;
    if (!model) return false;
    const key = `${model.provider}/${model.id}`;
    const cached = visionCapability.get(key);
    if (cached !== undefined) return cached;
    const res = await rpc.request({ type: "get_available_models" }, 8000);
    const models = (res.data as { models?: ModelInfo[] } | undefined)?.models ?? [];
    for (const item of models) {
      visionCapability.set(`${item.provider}/${item.id}`, Boolean(item.input?.includes("image")));
    }
    return visionCapability.get(key) ?? false;
  } catch {
    return false;
  }
}

function saveAttachment(data: string, mimeType: string): string | null {
  if (!workspaceRoot) return null;
  try {
    const dir = join(workspaceRoot, ".omcp", "attachments");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
    const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
    let file = join(dir, `${stamp}.${ext}`);
    let index = 1;
    while (existsSync(file)) file = join(dir, `${stamp}-${index++}.${ext}`);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return null;
  }
}

async function transcribeImages(images: ImageAttachment[]): Promise<string> {
  const vision = resolveVision();
  if (!vision) {
    return "[用户附了图片，但当前模型不支持图片且未配置视觉服务，图片未被读取]";
  }
  const config = { baseUrl: vision.baseUrl, model: vision.model, apiKey: vision.apiKey };
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const result = await describeImage(config, images[i].data, images[i].mimeType);
    if (result.ok) {
      parts.push(formatDescription(i, images.length, result.text ?? ""));
    } else {
      parts.push(`[图片 ${i + 1}/${images.length} 未能转述：${result.error ?? "未知错误"}]`);
    }
  }
  return parts.join("\n\n");
}

/**
 * 首条消息后给会话起名（R2）。失败静默：标题只是列表里的辅助信息，
 * 不值得为它阻断一次真实发送。
 */
function maybeAutoTitle(text: string): void {
  if (!workspaceRoot || !currentSessionFile) return;
  const key = sessionMetaKey(currentSessionFile);
  if (!key) return;
  const meta = loadSessionMeta(workspaceRoot);
  const entry = meta.sessions[key];
  if (entry?.title || entry?.renamed) return;
  const base = briefTitle(text);
  if (!base) return;
  const taken = Object.values(meta.sessions)
    .map((e) => e.title)
    .filter((t): t is string => Boolean(t));
  applyAutoTitles(workspaceRoot, { [key]: uniqueTitle(base, taken) });
}

ipcMain.handle(
  "pi:prompt",
  async (
    _event,
    text: string,
    images?: ImageAttachment[],
    opts?: { streamingBehavior?: "steer" | "followUp" },
    runtimeId?: string,
  ): Promise<PromptResult> => {
    const target =
      runtimeId && runtimeId !== "default"
        ? runtimeManager.require(runtimeId)
        : defaultRuntime;
    const notReady = await ensureSlotReady(target, 20_000);
    if (notReady) {
      console.log("[pi] prompt blocked: not ready");
      return notReady;
    }
    const list = Array.isArray(images) ? images.filter((img) => img && img.data) : [];
    const behavior = opts?.streamingBehavior;
    // 用户这句话进转写：事件流里没有"用户消息"，主进程收下 prompt 时补一条
    transcriptHub.userTurn(
      hubKeyForSlot(target.id),
      text,
      list.map((img, index) => ({
        id: `${Date.now().toString(36)}-${index}`,
        data: img.data,
        mimeType: img.mimeType,
      })),
    );
    // 只有没有进行中的回合时才开新记录；排队/追加不另起一条，避免把计时算到别人头上
    const trace = traceOf(target.id);
    const turnId = trace.begin("prompt", {
      textLen: text.length,
      images: list.length,
      runtime: target.id,
      ...(behavior ? { behavior } : {}),
    });
    const own = turnId !== null;
    if (own) {
      // 上一次 prompt 之后一共扫了几次会话账本；接入缓存后应接近 1
      trace.note("statsQueriesSinceLastPrompt", statsQueryCount);
      statsQueryCount = 0;
    }

    const budgetStart = performance.now();
    const budgetOk = await checkBudget(target);
    if (own) trace.note("budgetMs", performance.now() - budgetStart);
    if (!budgetOk) {
      if (own) trace.fail("budget");
      return { ok: false, error: "预算已用完，先调整上限或等明天" };
    }
    if (own) trace.phase("preparing");

    let res: PiResponse;
    const ackStart = performance.now();
    try {
      if (list.length === 0) {
        res = await target.rpc.request(
          behavior
            ? { type: "prompt", message: text, streamingBehavior: behavior }
            : { type: "prompt", message: text },
        );
      } else {
        for (const img of list) saveAttachment(img.data, img.mimeType);
        const supports = await modelSupportsImage();
        if (supports) {
          res = await target.rpc.request(
            behavior
              ? { type: "prompt", message: text, images: list, streamingBehavior: behavior }
              : { type: "prompt", message: text, images: list },
          );
        } else {
          const description = await transcribeImages(list);
          res = await target.rpc.request({
            type: "prompt",
            message: text + "\n\n" + description,
            ...(behavior ? { streamingBehavior: behavior } : {}),
          });
        }
      }
    } catch (err) {
      if (own) trace.fail("rpc-error");
      throw err;
    }
    if (own) trace.note("promptAckMs", performance.now() - ackStart);
    if (res.success) {
      if (target.id === "default") maybeAutoTitle(text);
    } else if (own) {
      trace.fail("rejected");
    }
    return promptResult(res);
  },
);

interface ResolvedVision {
  source: "registry" | "legacy";
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  hasKey: boolean;
}

/** 优先用注册表里的 vision 指向；没有就回落到旧的独立视觉配置 */
function resolveVision(): ResolvedVision | null {
  const registry = readRegistry();
  const v = registry.vision;
  if (v?.enabled && v.provider && v.model) {
    const provider = registry.providers[v.provider];
    const key = secretStore?.get(`provider:${v.provider}:apiKey`) ?? "";
    if (provider) {
      return {
        source: "registry",
        provider: v.provider,
        model: v.model,
        baseUrl: provider.baseUrl,
        apiKey: key || (provider.local ? "local" : ""),
        hasKey: Boolean(key) || provider.local === true,
      };
    }
  }
  if (appSettings.visionBaseUrl && appSettings.visionModel) {
    const key = secretStore?.get("vision:apiKey") ?? "";
    return {
      source: "legacy",
      provider: "",
      model: appSettings.visionModel,
      baseUrl: appSettings.visionBaseUrl,
      apiKey: key,
      hasKey: Boolean(key),
    };
  }
  return null;
}

function visionView(): VisionSettingsView {
  const v = resolveVision();
  return {
    enabled: Boolean(v),
    source: v?.source ?? "none",
    provider: v?.provider ?? "",
    baseUrl: v?.baseUrl ?? appSettings.visionBaseUrl,
    model: v?.model ?? appSettings.visionModel,
    hasKey: v?.hasKey ?? (secretStore?.has("vision:apiKey") ?? false),
    supported: secretStore?.isSupported() ?? false,
  };
}

function planStatus(): PlanGateStatus {
  return planGates.status(visiblePlanKey());
}

/**
 * 批准后的复核（P1-01）：计划文件被删/读不了/被改过，就撤销批准并退回只读。
 * 在每次非只读工具调用前由 PolicyService 调用；只读工具不触发（不影响看方案）。
 */
function revalidatePlanGate(key: string): { ok: boolean; reason?: string } {
  const driftedPath = planGates.for(key).planPath;
  const result = planGates.revalidate(
    key,
    verifyPlanFile,
    (rel) => planAbsPath(workspaceRoot ?? "", rel),
  );
  if (result.ok) return result;
  auditLog?.write({
    ts: new Date().toISOString(),
    toolName: "plan",
    ruleId: "plan:drift",
    decision: "deny",
    scope: "revoke",
    summary: `${result.reason ?? "方案内容已变更"}，已撤销批准：${driftedPath ?? "（无路径）"}`.slice(0, 200),
  });
  return result;
}

ipcMain.handle("route:load", (): RouteLoadResult => {
  if (!workspaceRoot) return { doc: { version: 1, updatedAt: new Date().toISOString(), steps: [] }, errors: [], exists: false };
  return loadRoute(workspaceRoot);
});

ipcMain.handle("route:save", (_event, doc: RouteDoc): RouteLoadResult & { ok: boolean } => {
  if (!workspaceRoot) {
    return { doc: { version: 1, updatedAt: new Date().toISOString(), steps: [] }, errors: ["没有打开工作区"], exists: false, ok: false };
  }
  const result = saveRoute(workspaceRoot, doc);
  return { ...result, exists: true };
});

ipcMain.handle("route:export", () => (workspaceRoot ? exportRoute(workspaceRoot) : { path: null, error: "没有打开工作区" }));

ipcMain.handle("plan:status", (): PlanGateStatus => planStatus());

ipcMain.handle("plan:set", (_event, enabled: boolean): PlanGateStatus => {
  planGates.setEnabled(visiblePlanKey(), Boolean(enabled));
  auditLog?.write({
    ts: new Date().toISOString(),
    toolName: "plan",
    ruleId: "plan:mode",
    decision: "allow",
    scope: enabled ? "enable" : "disable",
    summary: enabled ? "进入方案期（只读）" : "退出方案期",
  });
  return planStatus();
});

ipcMain.handle("plan:approve", (_event, planPath: string): PlanGateStatus => {
  if (!workspaceRoot) return planStatus();
  const gateKey = visiblePlanKey();
  if (!isValidPlanPath(workspaceRoot, planPath)) {
    planGates.revoke(gateKey);
    return planStatus();
  }
  // 批准 = 批准“这份内容”：记下摘要，之后文件一改就失效
  let digest: string | null = null;
  try {
    digest = planDigest(readFileSync(planAbsPath(workspaceRoot, planPath), "utf8"));
  } catch {
    digest = null;
  }
  if (!digest) {
    planGates.revoke(gateKey);
    return planStatus();
  }
  planGates.approve(gateKey, planPath, digest);
  auditLog?.write({
    ts: new Date().toISOString(),
    toolName: "plan",
    ruleId: "plan:approve",
    decision: "allow",
    scope: "approve",
    summary: `批准方案：${planPath}（sha256 ${digest.slice(0, 12)}）`,
  });
  return planStatus();
});

async function piRuntimeInfo(): Promise<PiRuntimeInfo> {
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const resolved = resolvePi(process.env.OMCP_PI_PATH, resources, process.env.OMCP_PI_DEV_ROOT);
  const expected =
    resolved.kind === "error"
      ? null
      : expectedVersion(resources, resolved.entry, process.env.OMCP_PI_DEV_ROOT);
  const actual =
    supervisor.getVersion() ??
    (resolved.kind === "error"
      ? null
      : await runVersion(
          resolved.entry,
          resolved.kind === "path" ? "path" : resolved.kind === "bin" ? "bin" : "node",
        ));
  const system = await probeSystemPi();
  return {
    origin: resolved.origin,
    entry: resolved.kind === "error" ? resolved.error ?? resolved.entry : resolved.entry,
    expected,
    actual,
    ok: resolved.kind !== "error" && (!expected || !actual || actual === expected),
    configDir: appSettings.piConfigDir || join(app.getPath("home"), ".pi", "agent"),
    configIsolated: Boolean(appSettings.piConfigDir),
    defaultIsolatedDir: join(app.getPath("userData"), "pi"),
    system,
  };
}

ipcMain.handle("pi:info", (): Promise<PiRuntimeInfo> => piRuntimeInfo());
ipcMain.handle("pi:ready", () => piReady);

ipcMain.handle("vision:get", (): VisionSettingsView => visionView());

ipcMain.handle(
  "vision:set",
  (_event, patch: { baseUrl?: string; model?: string; apiKey?: string }): VisionSettingsView => {
    if (typeof patch.baseUrl === "string") appSettings.visionBaseUrl = patch.baseUrl.trim();
    if (typeof patch.model === "string") appSettings.visionModel = patch.model.trim();
    if (typeof patch.apiKey === "string" && secretStore) {
      secretStore.set("vision:apiKey", patch.apiKey.trim());
    }
    saveAppSettings();
    return visionView();
  },
);

ipcMain.handle("vision:test", async (): Promise<DescribeResult> => {
  if (!visionConfigured() || !secretStore) {
    return { ok: false, error: "未配置视觉服务" };
  }
  // 1x1 透明 PNG，只用来验证端点可达
  const tiny =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return describeImage(
    {
      baseUrl: appSettings.visionBaseUrl,
      model: appSettings.visionModel,
      apiKey: secretStore.get("vision:apiKey") ?? "",
    },
    tiny,
    "image/png",
  );
});

ipcMain.handle(
  "vision:describe",
  (_event, data: string, mimeType?: string): Promise<DescribeResult> =>
    (() => {
      const v = resolveVision();
      if (!v) return Promise.resolve({ ok: false, error: "未配置视觉服务（注册表里没有 vision，也没有旧的独立配置）" });
      return describeImage({ baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey }, data, mimeType ?? "image/png");
    })(),
);

/**
 * 修改 4 · M0：发话前先确认这个**槽**能接活。
 *
 * 默认槽沿用 `piReady`（启动探测在那边）；其余槽用 `waitReady` 等一小会儿——
 * 切回挂起的会话时进程正在 resume，第一句不该直接失败（G5）。
 */
async function ensureSlotReady(
  target: SessionRuntime,
  timeoutMs = 60_000,
): Promise<PromptResult | null> {
  if (target.id === "default") {
    return piReady ? null : { ok: false, error: "pi 正在启动，请稍候再发送" };
  }
  if (target.ready) return null;
  try {
    await target.waitReady(timeoutMs);
    return null;
  } catch {
    return { ok: false, error: "这个会话的 pi 还没起好，稍等一下再发" };
  }
}

ipcMain.handle("pi:steer", async (_event, text: string, runtimeId?: string): Promise<PromptResult> => {
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  const notReady = await ensureSlotReady(target);
  if (notReady) return notReady;
  if (!(await checkBudget(target))) return { ok: false, error: "预算已用完，先调整上限或等明天" };
  transcriptHub.userTurn(hubKeyForSlot(target.id), text);
  return promptResult(await target.rpc.request({ type: "steer", message: text }));
});

ipcMain.handle("pi:follow-up", async (_event, text: string, runtimeId?: string): Promise<PromptResult> => {
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  const notReady = await ensureSlotReady(target);
  if (notReady) return notReady;
  if (!(await checkBudget(target))) return { ok: false, error: "预算已用完，先调整上限或等明天" };
  transcriptHub.userTurn(hubKeyForSlot(target.id), text);
  return promptResult(await target.rpc.request({ type: "follow_up", message: text }));
});

ipcMain.handle("pi:clear-queue", async (_event, runtimeId?: string) => {
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  const res = await target.rpc.request({ type: "clear_queue" });
  const data = res.data as { steering?: unknown; followUp?: unknown } | undefined;
  const steering = Array.isArray(data?.steering)
    ? data!.steering.filter((x): x is string => typeof x === "string")
    : [];
  const followUp = Array.isArray(data?.followUp)
    ? data!.followUp.filter((x): x is string => typeof x === "string")
    : [];
  return { ok: Boolean(res.success), steering, followUp };
});

ipcMain.handle("pi:abort", async (_event, runtimeId?: string) => {
  const target =
    runtimeId && runtimeId !== "default"
      ? runtimeManager.require(runtimeId)
      : defaultRuntime;
  traceOf(target.id).abort("user");
  // Optimistic: do not wait for the RPC abort response.
  target.rpc.send({ type: "abort" });
  clearAbortTimer();
  abortTimer = setTimeout(() => {
    abortTimer = null;
    // Hard fallback: restart this runtime, resuming its session file.
    target.stop();
    setTimeout(() => target.start(), 250);
  }, 3000);
  return true;
});

ipcMain.handle("pi:new-session", async (_event, runtimeId?: string, workspace?: string) => {
  invalidateStats();
  const wanted = workspace ? resolve(String(workspace)) : workspaceRoot;
  if (!wanted) return false;
  const t = switchTiming.begin("new-session");

  // 修改 5 · D2：允许「在另一个工作区新建会话」——先只切视图，再来一个槽
  if (sessionKey(wanted) !== sessionKey(workspaceRoot)) {
    const known = knownWorkspaceRoots();
    if (!known.some((item) => sessionKey(item) === sessionKey(wanted))) {
      throw new Error("这个工作区没有登记过");
    }
    activateWorkspaceView(wanted);
    const wsState = readWorkspaceState();
    const last = wsState.lastSessionFile ?? null;
    currentSessionFile = last && existsSync(last) ? last : null;
    applyPermissionMode();
    pointKernelsAt(currentSessionFile);
    switchTiming.mark(t, "view-switch");
  }

  // 传进来的槽必须属于这个工作区，否则忽略它——
  // 否则会在 A 的槽里给 B 建一个会话（cwd 是 A，文件却归 B）
  const explicit = runtimeId
    ? runtimeId !== "default"
      ? runtimeManager.get(runtimeId)
      : defaultRuntime
    : undefined;
  const target =
    explicit && sessionKey(explicit.workspace) === sessionKey(wanted)
      ? explicit
      : await acquireSlotForNewSession(wanted);
  switchTiming.mark(t, "slot", { id: target.id });

  const res = await target.rpc.request({ type: "new_session" });
  if (res.success) {
    invalidateWorkspaceIndex();
    sessionListCache.clear();
    sessionIndex.invalidate(sessionsDirOf(target.workspace));
    const state = await target.rpc.request({ type: "get_state" }).catch(() => null);
    const file = normalizeSessionFile((state?.data as SessionState | undefined)?.sessionFile);
    currentSessionFile = file;
    applyPermissionMode();
    slotPool.bindSession(target.id, file);
    pointKernelsAt(file);
    writeWorkspaceState({ lastSessionFile: file });
    void resetBudgetBaseline(target.id);
    // 新会话沿用“设为默认”的推理档（旧会话各自保留自己的记录）
    await target.rpc
      .request({ type: "set_thinking_level", level: appSettings.thinkingLevel })
      .catch(() => null);
    switchTiming.end(t, { slot: target.id, created: Boolean(file) });
  } else {
    switchTiming.end(t, { failed: true });
  }
  return res.success;
});

ipcMain.handle("pi:sessions", async (_event, runtimeId?: string) => {
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  return listSessions(target.sessionDir ?? sessionDir, target.workspace || workspaceRoot);
});

ipcMain.handle("session-meta:get", () => {
  if (!workspaceRoot) return { version: 1, sessions: {} };
  return loadSessionMeta(workspaceRoot);
});

ipcMain.handle(
  "session-meta:set",
  (_event, file: string, patch: { title?: string; archived?: boolean; permissionMode?: PermissionMode | null }) => {
  if (!workspaceRoot || !sessionDir) return { ok: false, error: "没有打开工作区" };
  const key = sessionMetaKey(file);
  if (!key || !existsSync(join(sessionDir, key))) return { ok: false, error: "会话不在当前工作区" };
  const res = patchSessionMeta(workspaceRoot, key, patch);
  // 会话档改了要立刻生效，否则要等切换会话才变
  if (res.ok && "permissionMode" in patch) applyPermissionMode();
  return res;
});

ipcMain.handle("notebook:load", () => {
  try {
    const data = JSON.parse(readFileSync(notebookPath(), "utf8")) as { cells?: NotebookCell[] };
    if (Array.isArray(data.cells)) return data.cells;
  } catch {
    // fall through
  }
  return [{ id: "cell-1", language: "python", code: "# Python\n" }] satisfies NotebookCell[];
});

ipcMain.handle("notebook:save", (_event, cells: NotebookCell[]) => {
  const file = notebookPath();
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ cells }, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return true;
});

ipcMain.handle(
  "kernel:run",
  async (_event, args: { runId: string; code: string; language?: "python" | "r" }) => {
    const service = args.language === "r" ? rKernel : pythonKernel;
    if (!service) return false;
    try {
      const mode = policyService?.info().mode;
      if (mode === "readonly" && !appSettings.readonlyNotebook) {
        reportError({
          code: "E_TOOL_BLOCKED",
          severity: "warning",
          title: "只读模式下笔记本已禁用",
          detail:
            "当前策略为 readonly。可在“权限”页勾选“只读时允许执行笔记本 cell”，或把策略改回 ask。",
          recoverable: true,
          action: "none",
        });
        return false;
      }
      await service.execute(args.code, (ev) => {
        if (ev.ev === "display" && ev.mime === "image/png" && ev.data) {
          saveFigure(ev.data);
        }
        send("kernel:event", { runId: args.runId, ...ev } satisfies KernelRunEvent);
      });
      return true;
    } catch (err) {
      send("kernel:event", {
        runId: args.runId,
        ev: "error",
        ename: "KernelError",
        evalue: (err as Error).message,
        traceback: [],
      } satisfies KernelRunEvent);
      send("kernel:event", {
        runId: args.runId,
        ev: "result",
        status: "error",
      } satisfies KernelRunEvent);
      return false;
    }
  },
);

ipcMain.handle("kernel:interrupt", async (_event, language?: "python" | "r") => {
  const service = language === "r" ? rKernel : pythonKernel;
  await service?.interrupt();
  return true;
});

ipcMain.handle("kernel:restart", async (_event, language?: "python" | "r") => {
  const service = language === "r" ? rKernel : pythonKernel;
  await service?.restart();
  return true;
});

ipcMain.handle("kernel:variables", async (_event, language?: "python" | "r") => {
  const service = language === "r" ? rKernel : pythonKernel;
  return (await service?.variables()) ?? [];
});

/**
 * 探测本机解释器（K3 的纯函数 + 真实执行）。
 * 8 秒超时，与 sidecar 的探测口径一致。
 */
function runProbe(cmd: string, args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number; killed?: boolean }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        timedOut: Boolean(e && e.killed),
      });
    });
  });
}

ipcMain.handle("kernel:detect", async (_event, language: "python" | "r") => {
  const specs = discoverKernelSpecs({ home: app.getPath("home") });
  const deps = realDeps(
    { python: appSettings.pythonPath, r: appSettings.rPath },
    specCandidates(specs),
  );
  return probeInterpreters(language, deps, runProbe);
});

function kernelStatusList() {
  const specs = discoverKernelSpecs({ home: app.getPath("home") });
  const rSpec = specs.specs.find((s) => (s.language ?? "").toLowerCase() === "r");
  return [
    {
      language: "python" as const,
      configuredPath: appSettings.pythonPath,
      resolvedPath: pythonKernel?.pythonPath ?? "",
      ready: pythonKernel?.isReady ?? false,
      specSource: (pythonKernel?.explicitInterpreter ? "generated" : "fallback") as
        | "generated"
        | "fallback",
    },
    {
      language: "r" as const,
      configuredPath: appSettings.rPath,
      resolvedPath: appSettings.rPath || rSpec?.executable || "",
      ready: rKernel?.isReady ?? false,
      specSource: (rKernel?.explicitInterpreter ? "generated" : "fallback") as
        | "generated"
        | "fallback",
    },
  ];
}

ipcMain.handle("kernel:status", () => kernelStatusList());

/** 用量缓存：<userData>/usage-cache.json，按文件 mtime+size 增量 */
function usageCachePath(): string {
  return join(app.getPath("userData"), "usage-cache.json");
}

function readUsageCache(): ScanCache {
  try {
    const raw = JSON.parse(readFileSync(usageCachePath(), "utf8")) as ScanCache;
    return raw && raw.version === 1 && raw.files ? raw : emptyCache();
  } catch {
    return emptyCache();
  }
}

function writeUsageCache(cache: ScanCache): void {
  try {
    const file = usageCachePath();
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(cache) + "\n", "utf8");
    renameSync(tmp, file);
  } catch {
    // 缓存写不进去不影响结果
  }
}

ipcMain.handle("usage:get", () => {
  const empty = aggregateUsage([], 0);
  if (!workspaceRoot) {
    return { data: empty, meta: { files: 0, parsed: 0, reused: 0, cachePath: usageCachePath() } };
  }
  const dir = join(workspaceRoot, ".omcp", "sessions");
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => join(dir, n));
  } catch {
    return { data: empty, meta: { files: 0, parsed: 0, reused: 0, cachePath: usageCachePath() } };
  }
  try {
    const cache = readUsageCache();
    const scanned = scanSessions(files, cache);
    writeUsageCache(cache);
    return {
      data: aggregateUsage(scanned.records, scanned.silentTurns),
      meta: {
        files: scanned.files,
        parsed: scanned.parsed,
        reused: scanned.reused,
        cachePath: usageCachePath(),
      },
    };
  } catch (err) {
    return {
      data: empty,
      meta: {
        files: files.length,
        parsed: 0,
        reused: 0,
        cachePath: usageCachePath(),
        error: (err as Error).message,
      },
    };
  }
});

ipcMain.handle("kernel:specs", () => {
  const d = discoverKernelSpecs({ home: app.getPath("home") });
  return {
    specs: d.specs,
    problems: d.problems,
    shadowed: d.shadowed,
  };
});

ipcMain.handle("kernel:save-path", async (_event, language: "python" | "r", raw: string) => {
  const next = String(raw ?? "").trim();
  if (next) {
    if (!/^[A-Za-z]:[\\/]|^\//.test(next)) {
      return { ok: false, error: "请填绝对路径（例如 D:/Python313/python.exe）" };
    }
    if (!existsSync(next)) {
      return { ok: false, error: `路径不存在：${next}` };
    }
  }
  const current = language === "r" ? appSettings.rPath : appSettings.pythonPath;
  if (next === current) {
    return { ok: true, restarted: false, status: kernelStatusList() };
  }
  if (language === "r") {
    appSettings.rPath = next;
    kernelManager?.setRPath(next);
  } else {
    appSettings.pythonPath = next;
    kernelManager?.setPythonPath(next);
  }
  saveAppSettings();
  const service = language === "r" ? rKernel : pythonKernel;
  try {
    await service?.restart();
  } catch (err) {
    // 路径已保存，但内核没起来（例如目标解释器缺 ipykernel）：把原因带回去，别只显示“已保存”
    return {
      ok: true,
      restarted: true,
      error: `已保存，但内核没能起来：${(err as Error).message}`,
      status: kernelStatusList(),
    };
  }
  return { ok: true, restarted: true, status: kernelStatusList() };
});

ipcMain.handle("fs:list", (_event, relPath: string) => {
  if (!workspaceRoot) return { path: "", entries: [], truncated: false, error: "没有打开工作区" };
  return listWorkspaceDir(workspaceRoot, relPath);
});

ipcMain.handle("artifacts:list", () => {
  if (!artifactService) {
    return { artifacts: [], unknownRuns: 0, observed: 0, scannedAt: new Date().toISOString(), error: "产物服务未启动" };
  }
  return artifactService.list();
});

ipcMain.handle("fs:stat", (_event, relPath: string) => {
  if (!workspaceRoot) {
    return { path: "", name: "", type: "file", size: 0, mtime: "", error: "没有打开工作区" };
  }
  return statWorkspacePath(workspaceRoot, relPath);
});

ipcMain.handle("fs:read", (_event, relPath: string) => {
  if (!workspaceRoot) {
    return { path: "", kind: "binary", size: 0, error: "没有打开工作区" };
  }
  return readWorkspaceFile(workspaceRoot, relPath);
});

ipcMain.handle("workspace:current", () => ({
  root: workspaceRoot,
  recent: readWorkspaces().recent ?? [],
}));

/* ------------------------------------------------------------------ */
/* 工作区索引（修改2）：最近工作区的会话数，只读目录，不解析 JSONL      */
/* ------------------------------------------------------------------ */

let workspaceIndexCache: { at: number; data: WorkspaceIndexEntry[] } | null = null;
/** 别的工作区的会话列表缓存（修改 5 · C5）：侧栏展开时才拉，15 秒内不重复扫盘 */
const sessionListCache = new Map<
  string,
  { at: number; data: { sessions: SessionSummary[]; titles: Record<string, string> } }
>();

function invalidateWorkspaceIndex(): void {
  workspaceIndexCache = null;
}

/**
 * 侧栏的工作区概览（修改 5 · C6 续）：异步 + 复用 `SessionIndex` 的增量缓存。
 *
 * 旧实现在主线程上对**每个最近工作区**做一遍 `readdirSync + statSync`，
 * 工作区和会话一多，就成了切换时第二处卡顿源。
 */
async function buildWorkspaceIndex(): Promise<WorkspaceIndexEntry[]> {
  const roots = [workspaceRoot, ...(readWorkspaces().recent ?? [])]
    .map((r) => String(r ?? "").trim())
    .filter(Boolean);
  const unique = [...new Set(roots)];
  const out: WorkspaceIndexEntry[] = [];
  for (const root of unique) {
    const { count, latestMs } = await sessionIndex.summarize(sessionsDirOf(root));
    out.push({
      root,
      sessionCount: count,
      ...(latestMs > 0 ? { updatedAt: new Date(latestMs).toISOString() } : {}),
    });
  }
  return out;
}

ipcMain.handle("workspace:index", async (): Promise<WorkspaceIndexEntry[]> => {
  const now = Date.now();
  if (workspaceIndexCache && now - workspaceIndexCache.at < 30_000) {
    return workspaceIndexCache.data;
  }
  const data = await buildWorkspaceIndex();
  workspaceIndexCache = { at: now, data };
  return data;
});

ipcMain.handle("session:delete", (_event, file: string) => {
  if (!workspaceRoot || !sessionDir) return { ok: false, error: "没有打开工作区" };
  const key = sessionMetaKey(file);
  if (!key) return { ok: false, error: "会话文件名不合法" };
  if (currentSessionFile && basename(currentSessionFile) === key) {
    return { ok: false, error: "当前会话不能删除，请先切换" };
  }
  const target = join(sessionDir, key);
  if (!existsSync(target)) return { ok: false, error: "会话文件不存在" };
  try {
    const trash = join(workspaceRoot, ".omcp", "trash", "sessions");
    mkdirSync(trash, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(target, join(trash, `${stamp}-${key}`));
    invalidateWorkspaceIndex();
    sessionIndex.invalidate(sessionDir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/* ------------------------------------------------------------------ */
/* 项目与会话（修改五）                                                */
/* ------------------------------------------------------------------ */

/**
 * 侧栏两段的数据：项目（文件夹工作区）与临时会话（scratch）。
 *
 * 计数复用 `SessionIndex.summarize`（异步 + 增量 + 30 s 缓存），
 * 不开新扫描路径。
 */
ipcMain.handle("projects:list", async () => {
  const projects = readProjects();
  const out: Array<ProjectRecord & { sessionCount: number; lastActiveAt?: string }> = [];
  for (const project of projects) {
    const { count, latestMs } = await sessionIndex.summarize(sessionsDirOf(project.root));
    out.push({
      ...project,
      sessionCount: count,
      ...(latestMs > 0 ? { lastActiveAt: new Date(latestMs).toISOString() } : {}),
    });
  }
  const scratch = scratchRoot();
  const scratchDir = sessionsDirOf(scratch);
  try {
    mkdirSync(scratchDir, { recursive: true });
  } catch {
    // 建不出来就让列表报 0，不影响别的
  }
  const scratchSummary = await sessionIndex.summarize(scratchDir);
  return {
    projects: out,
    scratch: {
      root: scratch,
      sessionCount: scratchSummary.count,
      ...(scratchSummary.latestMs > 0
        ? { lastActiveAt: new Date(scratchSummary.latestMs).toISOString() }
        : {}),
    },
  };
});

ipcMain.handle("projects:rename", (_event, root: string, name: string) => {
  const next = renameProject(readProjects(), String(root ?? ""), String(name ?? ""));
  saveProjects(next);
  return next;
});

/** 多选里的"移出列表"：只改表，不动磁盘上任何文件 */
ipcMain.handle("projects:forget", (_event, roots: string[]) => {
  const list = Array.isArray(roots) ? roots.filter((r): r is string => typeof r === "string") : [];
  saveProjects(forgetProjects(readProjects(), list));
  const state = readWorkspaces();
  const drop = new Set(list.map((r) => sessionKey(r)));
  writeWorkspaces({ recent: (state.recent ?? []).filter((r) => !drop.has(sessionKey(r))) });
  invalidateWorkspaceIndex();
  return readProjects();
});

/** 批量归档 / 还原：只写各会话所在工作区的 meta，不碰 provider */
ipcMain.handle("sessions:archive", (_event, files: string[], archived: boolean) => {
  const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  let ok = 0;
  const failed: string[] = [];
  for (const file of list) {
    const root = resolveSessionWorkspace(file) ?? workspaceRoot;
    const key = sessionMetaKey(file);
    if (!root || !key) {
      failed.push(file);
      continue;
    }
    try {
      patchSessionMeta(root, key, { archived });
      ok += 1;
    } catch {
      failed.push(file);
    }
  }
  invalidateWorkspaceIndex();
  sessionListCache.clear();
  return { ok, failed };
});

/** 批量删除：挪进各自工作区的 .omcp/trash/sessions；当前会话跳过 */
ipcMain.handle("sessions:remove", (_event, files: string[]) => {
  const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
  let ok = 0;
  const failed: Array<{ file: string; reason: string }> = [];
  for (const file of list) {
    const root = resolveSessionWorkspace(file) ?? workspaceRoot;
    const key = sessionMetaKey(file);
    if (!root || !key) {
      failed.push({ file, reason: "找不到所属工作区" });
      continue;
    }
    if (currentSessionFile && sessionKey(currentSessionFile) === sessionKey(file)) {
      failed.push({ file, reason: "当前会话不能删除，先切走" });
      continue;
    }
    const target = join(sessionsDirOf(root), key);
    if (!existsSync(target)) {
      failed.push({ file, reason: "文件不存在" });
      continue;
    }
    try {
      const trash = join(root, ".omcp", "trash", "sessions");
      mkdirSync(trash, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      renameSync(target, join(trash, `${stamp}-${key}`));
      sessionIndex.invalidate(sessionsDirOf(root));
      ok += 1;
    } catch (err) {
      failed.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  invalidateWorkspaceIndex();
  sessionListCache.clear();
  return { ok, failed };
});

/* ------------------------------------------------------------------ */
/* 上传（修改1）：工作区内引用、工作区外复制、图片附件                  */
/* ------------------------------------------------------------------ */

const uploadImports = new Map<string, AbortController>();

function auditUpload(summary: string, files: string[]): void {
  auditLog?.write({
    ts: new Date().toISOString(),
    toolName: "upload",
    ruleId: "upload:pick",
    decision: "allow",
    scope: "upload",
    summary,
    files,
    sessionId: currentSessionFile ?? undefined,
  });
}

ipcMain.handle("upload:pick", async (_event, kind: UploadKind): Promise<PickUploadResult> => {
  if (!workspaceRoot) {
    return { canceled: true, files: [], rejected: [{ name: "", reason: "先打开工作区" }] };
  }
  if (!win) return { canceled: true, files: [] };
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: filtersFor(kind === "image" ? "image" : kind === "data" ? "data" : "file"),
  });
  if (result.canceled) return { canceled: true, files: [] };

  const files: PickedUpload[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  let imageCount = 0;
  for (const p of result.filePaths) {
    try {
      const c = await classifyUpload(p, workspaceRoot);
      if (kind === "image") {
        if (imageCount >= UPLOAD_IMAGE_MAX_COUNT) {
          rejected.push({ name: basename(p), reason: `最多 ${UPLOAD_IMAGE_MAX_COUNT} 张` });
          continue;
        }
        const img = await readImageBase64(c.path, UPLOAD_IMAGE_MAX_BYTES);
        files.push({ ...c, ...img });
        imageCount += 1;
      } else {
        files.push(c);
      }
    } catch (err) {
      rejected.push({
        name: basename(p),
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 这里只审计“已经落位”的引用与图片；外部文件等 import 成功后再记复制
  const refs = files
    .filter((f) => !f.data && f.insideWorkspace && f.relative && !/\s/.test(f.relative))
    .map((f) => f.relative!);
  const images = files.filter((f) => f.data).map((f) => f.name);
  if (refs.length + images.length > 0) {
    auditUpload(
      `上传 ${refs.length + images.length} 项（${refs.length} 引用 / ${images.length} 图片）`,
      [...refs, ...images],
    );
  }

  return { canceled: false, files, ...(rejected.length ? { rejected } : {}) };
});

ipcMain.handle(
  "upload:import",
  async (
    _event,
    args: { paths?: unknown; importId?: unknown },
  ): Promise<{ ok: boolean; files: string[]; error?: string }> => {
    if (!workspaceRoot) return { ok: false, files: [], error: "先打开工作区" };
    const paths = Array.isArray(args?.paths)
      ? args.paths.filter((x): x is string => typeof x === "string")
      : [];
    const rawId = typeof args?.importId === "string" ? args.importId : "";
    const importId = /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : `u${Date.now()}`;
    const controller = new AbortController();
    uploadImports.set(importId, controller);

    const out: string[] = [];
    const errors: string[] = [];
    let refs = 0;
    let copies = 0;
    try {
      for (const p of paths) {
        if (controller.signal.aborted) {
          errors.push("已取消");
          break;
        }
        try {
          const c = await classifyUpload(p, workspaceRoot);
          if (c.insideWorkspace && c.relative && !/\s/.test(c.relative)) {
            out.push(c.relative);
            refs += 1;
            continue;
          }
          const dir = uploadDateDir(workspaceRoot);
          const dest = uniqueDestination(dir, safeFileName(c.name));
          await checkDiskSpace(workspaceRoot, c.size);
          await copyWithProgress(c.path, dest, c.size, {
            signal: controller.signal,
            onProgress: (copiedBytes, totalBytes) =>
              send("upload:progress", { importId, file: c.name, copiedBytes, totalBytes }),
          });
          out.push(relative(workspaceRoot, dest).split(sep).join("/"));
          copies += 1;
        } catch (err) {
          errors.push(`${basename(p)}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (out.length > 0) {
        auditUpload(`上传 ${out.length} 个文件（${refs} 引用 / ${copies} 复制）`, out);
      }
      return {
        ok: errors.length === 0,
        files: out,
        ...(errors.length ? { error: errors.join("；") } : {}),
      };
    } finally {
      uploadImports.delete(importId);
    }
  },
);

ipcMain.handle("upload:cancel", (_event, importId: string) => {
  const controller = uploadImports.get(String(importId));
  if (!controller) return false;
  controller.abort();
  return true;
});

ipcMain.handle("workspace:pick", async () => {
  const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
  const selected = result.filePaths[0];
  if (result.canceled || !selected) return null;
  return openWorkspace(selected);
});

ipcMain.handle("workspace:open", async (_event, root: string) => {
  if (!existsSync(root)) throw new Error("目录不存在");
  return openWorkspace(root);
});

ipcMain.handle("pi:tree", async () => {
  const res = await rpc.request({ type: "get_tree" }, piReady ? 30_000 : 3_000);
  return res.data as SessionTreeResult;
});

ipcMain.handle("pi:fork", async (_event, entryId: string, runtimeId?: string) => {
  invalidateStats();
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  const res = await target.rpc.request({ type: "fork", entryId });
  const data = (res.data ?? {}) as ForkResult;
  if (target.id === "default") {
    await syncCurrentSession();
  } else {
    const state = await target.rpc.request({ type: "get_state" }).catch(() => null);
    const file = normalizeSessionFile((state?.data as SessionState | undefined)?.sessionFile);
    slotPool.bindSession(target.id, file);
  }
  const sessionFile = target.id === "default" ? currentSessionFile : target.sessionFile;
  const persisted = !!(sessionFile && existsSync(sessionFile));
  return { ...data, sessionFile: sessionFile ?? undefined, persisted };
});

ipcMain.handle("pi:clone", async (_event, runtimeId?: string) => {
  invalidateStats();
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  const res = await target.rpc.request({ type: "clone" });
  const data = (res.data ?? {}) as SessionSwitchResult;
  if (target.id === "default") {
    await syncCurrentSession();
  } else {
    const state = await target.rpc.request({ type: "get_state" }).catch(() => null);
    const file = normalizeSessionFile((state?.data as SessionState | undefined)?.sessionFile);
    slotPool.bindSession(target.id, file);
  }
  return data;
});

ipcMain.handle("pi:export-html", async (_event, outputPath?: string) => {
  mkdirSync(exportsDir, { recursive: true });
  const target = outputPath || join(exportsDir, `session-${Date.now()}.html`);
  const res = await rpc.request({
    type: "export_html",
    outputPath: target,
  });
  if (!res.success) return null;
  const path = (res.data as { path?: string } | undefined)?.path ?? target;
  if (!SELFTEST) void shell.openPath(path);
  return path;
});

ipcMain.handle("pi:restart", async () => {
  defaultRuntime.stop();
  setTimeout(() => defaultRuntime.start(), 300);
  return true;
});

/**
 * 用系统浏览器打开链接（P2-04）。
 * 只放行 http/https/mailto：绝不把 `javascript:`、`data:`、`file:` 交给系统处理。
 * 协议检查放在主进程，renderer 的判断只用于给提示。
 */
ipcMain.handle("shell:open-external", async (_event, url: string) => {
  const raw = String(url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "链接格式不正确" };
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
    return { ok: false, error: `不打开这种协议：${parsed.protocol}` };
  }
  try {
    await shell.openExternal(raw);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("pi:models", async () => {
  const res = await rpc.request({ type: "get_available_models" }, piReady ? 30_000 : 3_000);
  const data = res.data as { models?: ModelInfo[] } | undefined;
  return data?.models ?? [];
});

ipcMain.handle("models:registry-get", () => {
  const registry = readRegistry();
  /** 所有认识的服务商都给出凭据来源：模型选择器据此判断「缺密钥」 */
  const credentials: Record<string, CredentialSource> = {};
  for (const p of catalogProviders()) credentials[p.id] = credentialStatus(p.id).source;
  for (const id of Object.keys(registry.providers)) credentials[id] = credentialStatus(id).source;
  return {
    registry,
    file: registryFile(),
    agentDir: resolveAgentDir(),
    piModelsPath: piModelsPath(),
    keys: Object.fromEntries(Object.keys(registry.providers).map((id) => [id, hasProviderKey(id)])),
    credentials,
    /** models.json 里写成明文的 provider（只报 id，不回传密钥）。仅提示，不自动改。 */
    plaintextKeys: findPlaintextModelKeys(),
  };
});

ipcMain.handle("models:registry-set", (_event, raw: unknown) => {
  const { registry, errors } = validateRegistry(raw);
  if (errors.length) return { ok: false, errors, warnings: [], written: false };
  const old = readRegistry();
  // 上一次写过、这次不在了的 provider，要从 models.json 撤掉
  const stale = (old.managed ?? []).filter((id) => !(id in registry.providers));
  registry.managed = Object.keys(registry.providers);
  const saved = writeRegistry(registry);
  if (!saved.ok) return { ok: false, errors: [saved.error ?? "写入失败"], warnings: [], written: false };
  applyRegistryEnv();
  const sync = syncRegistryToPi(registry, stale);
  if (sync.written) {
    defaultRuntime.stop();
    setTimeout(() => defaultRuntime.start(), 300);
  }
  return {
    ok: sync.ok,
    errors: sync.error ? [sync.error] : [],
    warnings: sync.warnings,
    written: sync.written,
    backup: sync.backup,
  };
});

ipcMain.handle("models:import", () => {
  const file = piModelsPath();
  if (!existsSync(file)) return { ok: false, count: 0, skipped: [], error: "没有找到 models.json" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, count: 0, skipped: [], error: "models.json 不是合法 JSON" };
  }
  const imported = fromPiProviders(raw);
  if (!imported.count) return { ok: false, count: 0, skipped: imported.skipped, error: "没有可导入的 provider" };
  const current = readRegistry();
  const merged: ModelRegistry = {
    version: 1,
    providers: { ...current.providers, ...imported.registry.providers },
  };
  const saved = writeRegistry(merged);
  if (!saved.ok) return { ok: false, count: 0, skipped: imported.skipped, error: saved.error };
  return { ok: true, count: imported.count, skipped: imported.skipped };
});

/** 对任意 OpenAI 兼容端点做一次 GET /models（不依赖注册表） */
ipcMain.handle("models:test", async (_event, id: string) => {
  const registry = readRegistry();
  const provider = registry.providers[id];
  if (!provider) return { ok: false, ms: 0, error: "没有这个 provider" };
  const key = secretStore?.get(`provider:${id}:apiKey`) ?? (provider.local ? "local" : "");
  if (!key) return { ok: false, ms: 0, error: "未设置密钥" };
  return probeModels(provider.baseUrl, key, provider.api);
});

ipcMain.handle("models:probe", async (_event, baseUrl: string, apiKey: string, api?: string) => {
  if (!/^https?:\/\//i.test(String(baseUrl ?? ""))) {
    return { ok: false, ms: 0, error: "Base URL 必须以 http(s) 开头" };
  }
  return probeModels(String(baseUrl), String(apiKey ?? "").trim() || "local", api);
});

ipcMain.handle("models:catalog", () => {
  const loaded = loadProviderCatalog(
    process.resourcesPath,
    app.getAppPath(),
  );
  return {
    providers: loaded.catalog?.providers ?? [],
    path: loaded.path,
    ...(loaded.error ? { error: loaded.error } : {}),
  };
});

/**
 * 发送前预检（PR1）：把「缺凭据 / 地址不对 / 模型不存在」在发送之前说清楚。
 */
ipcMain.handle("model:preflight", (_event, provider: string, modelId: string) => {
  const id = String(provider ?? "").trim();
  const model = String(modelId ?? "").trim();
  const reg = readRegistry();
  const status = credentialStatus(id);
  const result = preflightModel({
    provider: id,
    modelId: model,
    config: reg.providers[id] ?? null,
    catalog: catalogProvider(id),
    hasCredential: status.has,
  });
  return { ...result, credentialSource: status.source };
});

/**
 * 补全连接信息对话框的数据（PR2）：目录默认值 + 现有配置 + 凭据来源 + 将写入的片段。
 * 片段里只有 $OMCP_KEY_<ID> 引用，不含真实密钥。
 */
ipcMain.handle("model:setup-info", (_event, provider: string) => {
  const id = String(provider ?? "").trim();
  const reg = readRegistry();
  const cfg = reg.providers[id] ?? null;
  const cat = catalogProvider(id);
  const merged = new Map<string, RegistryModel>();
  for (const m of cat?.models ?? []) merged.set(m.id, m as unknown as RegistryModel);
  for (const m of cfg?.models ?? []) merged.set(m.id, { ...(merged.get(m.id) ?? { id: m.id }), ...m });
  const baseUrl = cfg?.baseUrl || cat?.baseUrl || "";
  const api = cfg?.api || cat?.api || "openai-completions";
  const preview = previewPiProvider(
    id,
    { baseUrl, api, local: cfg?.local, models: [...merged.values()] },
    catalogModelMeta,
  );
  return {
    provider: id,
    known: Boolean(cat),
    catalog: cat ? { baseUrl: cat.baseUrl, api: cat.api, requiresBaseUrl: cat.requiresBaseUrl } : null,
    config: cfg,
    credential: credentialStatus(id),
    envKeys: credentialEnvNames(id, cat?.envKeys),
    models: [...merged.values()],
    preview,
  };
});

/**
 * 保存连接信息 + 密钥（PR2）。
 *
 * 纪律（已定的决定）：**不允许只填 key 就建记录**——这里要求带上 baseUrl 与至少一个模型，
 * 界面上也必须先让用户看到并确认这些内容；取消时什么都不写。
 */
ipcMain.handle("model:setup-save", (_event, input: unknown) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = String(raw.provider ?? "").trim();
  const baseUrl = String(raw.baseUrl ?? "").trim();
  const api = String(raw.api ?? "").trim() || "openai-completions";
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const modelIds = Array.isArray(raw.modelIds)
    ? [...new Set(raw.modelIds.map((m) => String(m ?? "").trim()).filter(Boolean))]
    : [];
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) return { ok: false, errors: ["服务商 id 非法"] };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, errors: ["服务地址必须是 http(s) 链接"] };
  if (modelIds.length === 0) return { ok: false, errors: ["至少要勾选一个模型"] };

  const registry = readRegistry();
  const existing = registry.providers[id];
  const cat = catalogProvider(id);

  // 用现有的校验器过一遍，避免形态不一致
  const candidate = {
    version: 1,
    providers: {
      ...registry.providers,
      [id]: {
        baseUrl,
        api,
        origin: existing?.origin ?? (cat ? "builtin" : "custom"),
        ...(existing?.local ? { local: true } : {}),
        models: modelIds.map((mid) => {
          const prev = existing?.models.find((m) => m.id === mid);
          const meta = catalogModelMeta(id, mid);
          return prev ? { ...meta, ...prev } : { ...(meta ?? { id: mid }) };
        }),
      },
    },
  };
  const checked = validateRegistry(candidate);
  if (checked.errors.length) return { ok: false, errors: checked.errors };

  if (apiKey && secretStore) {
    if (!secretStore.set(`provider:${id}:apiKey`, apiKey)) {
      return { ok: false, errors: ["当前系统不支持安全存储，未保存密钥"] };
    }
  }
  const stale = (registry.managed ?? []).filter((x) => !(x in checked.registry.providers));
  checked.registry.managed = Object.keys(checked.registry.providers);
  const saved = writeRegistry(checked.registry);
  if (!saved.ok) return { ok: false, errors: [saved.error ?? "写入失败"] };

  applyRegistryEnv();
  const sync = syncRegistryToPi(checked.registry, stale);
  defaultRuntime.stop();
  setTimeout(() => defaultRuntime.start(), 300);
  return {
    ok: sync.ok,
    errors: sync.error ? [sync.error] : [],
    warnings: sync.warnings,
    written: sync.written,
    restarted: true,
    credential: credentialStatus(id).source,
    preview: previewPiProvider(id, checked.registry.providers[id]!, catalogModelMeta),
  };
});

ipcMain.handle("models:add-provider", (_event, input: unknown) => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = String(raw.id ?? "").trim();
  const baseUrl = String(raw.baseUrl ?? "").trim();
  const api = String(raw.api ?? "openai-completions").trim();
  const models = Array.isArray(raw.models) ? raw.models : [];
  const apiKey = String(raw.apiKey ?? "").trim();

  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) return { ok: false, error: "provider id 非法" };
  if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, error: "Base URL 必须填 http(s) 地址" };
  if (models.length === 0) return { ok: false, error: "至少需要一个模型" };

  const registry = readRegistry();
  if (registry.providers[id]) return { ok: false, error: `「${id}」已经在注册表里了` };

  registry.providers[id] = {
    baseUrl,
    api,
    models: models as never,
  };
  registry.managed = [...new Set([...(registry.managed ?? []), id])];
  const saved = writeRegistry(registry);
  if (!saved.ok) return { ok: false, error: saved.error ?? "写入失败" };

  if (apiKey && secretStore) secretStore.set(`provider:${id}:apiKey`, apiKey);

  applyRegistryEnv();
  const sync = syncRegistryToPi(registry);
  if (sync.written) {
    defaultRuntime.stop();
    setTimeout(() => defaultRuntime.start(), 300);
  }
  return {
    ok: sync.ok,
    ...(sync.error ? { error: sync.error } : {}),
    written: sync.written,
    warnings: sync.warnings,
  };
});

ipcMain.handle("models:key-set", (_event, id: string, key: string) => {
  if (!secretStore) return { ok: false, error: "当前系统不支持安全存储" };
  const registry = readRegistry();
  if (!registry.providers[id]) return { ok: false, error: "没有这个 provider" };
  const trimmed = String(key ?? "").trim();
  if (trimmed) secretStore.set(`provider:${id}:apiKey`, trimmed);
  else secretStore.clear(`provider:${id}:apiKey`);
  applyRegistryEnv();
  const sync = syncRegistryToPi();
  // 密钥走环境变量注入，pi 进程只在启动时读一次。models.json 里写的是 $OMCP_KEY_*，
  // 换密钥时文件内容不变，靠 sync.written 判断就不会重启，新密钥对运行中的 pi 无效。
  defaultRuntime.stop();
  setTimeout(() => defaultRuntime.start(), 300);
  return { ok: sync.ok, error: sync.error, written: sync.written, warnings: sync.warnings, restarted: true };
});

ipcMain.handle(
  "pi:set-model",
  async (_event, provider: string, modelId: string, runtimeId?: string): Promise<SetModelResult> => {
    const target =
      runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
    const res = await target.rpc.request({ type: "set_model", provider, modelId });
    if (!res.success) {
      const error = String(res.error ?? "").trim() || "pi 未说明原因";
      reportError({
        code: "E_MODEL_SWITCH",
        severity: "error",
        title: "切换模型失败",
        detail: "无法切换到所选模型",
        raw: `${provider}/${modelId}：${error}`.slice(0, 500),
        recoverable: true,
        action: "open-settings",
      });
      return { ok: false, error };
    }
    target.setModel(provider, modelId);
    // 只有默认 runtime 的模型才成为下次启动的默认值
    if (target.id === "default") {
      appSettings.provider = provider;
      appSettings.model = modelId;
      defaultRuntime.setModel(provider, modelId);
      saveAppSettings();
    }
    return { ok: true };
  },
);

ipcMain.handle("pi:thinking-levels", async (_event, runtimeId?: string): Promise<ThinkingLevel[]> => {
  const target =
    runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
  // 失败必须抛错：空数组是合法结果（模型没有可调档位），两者不能混
  const res = await target.rpc.request({ type: "get_available_thinking_levels" }, 8000);
  if (!res.success) throw new Error(String(res.error ?? "pi 没有返回可用档位"));
  const levels = (res.data as { levels?: unknown } | undefined)?.levels;
  if (!Array.isArray(levels)) throw new Error("pi 返回的档位格式不正确");
  return levels.filter(isThinkingLevel);
});

ipcMain.handle(
  "pi:set-thinking-level",
  async (_event, level: unknown, runtimeId?: string): Promise<SetModelResult> => {
    if (!isThinkingLevel(level)) return { ok: false, error: "未知的推理档位" };
    const target =
      runtimeId && runtimeId !== "default" ? runtimeManager.require(runtimeId) : defaultRuntime;
    const res = await target.rpc.request({ type: "set_thinking_level", level });
    if (!res.success) {
      return { ok: false, error: String(res.error ?? "").trim() || "pi 未说明原因" };
    }
    target.setThinkingLevel(level);
    if (target.id === "default") {
      appSettings.thinkingLevel = level;
      defaultRuntime.setThinkingLevel(level);
      saveAppSettings();
    }
    return { ok: true };
  },
);

ipcMain.handle("pi:messages", async () => {
  const res = await rpc.request({ type: "get_messages" }, piReady ? 30_000 : 3_000);
  const data = res.data as { messages?: AgentMessage[] } | undefined;
  return data?.messages ?? [];
});

ipcMain.handle("pi:state", async () => {
  const res = await rpc.request({ type: "get_state" }, piReady ? 30_000 : 3_000);
  const state = res.data as SessionState;
  const file = normalizeSessionFile(state?.sessionFile);
  if (file) {
    const switched = file !== currentSessionFile;
    state.sessionFile = file;
    currentSessionFile = file;
    // 走登记表，别绕过它——否则内核键与 ServiceHub 的会话会落后（M2）
    bindDefaultSession(file);
    if (switched) resetPlanGate(`session:${sessionKey(file)}`);
    if (existsSync(file)) writeWorkspaceState({ lastSessionFile: file });
  }
  return state;
});

/** pi 的默认 reserveTokens（见 pi docs/settings.md）；compactAt = 上限 − 这个值 */
const PI_COMPACT_RESERVE = 16384;

ipcMain.handle("pi:stats", async () => {
  // 走共享缓存/单飞：回合末 footer、预算、上下文仪表不再各自扫一遍账本
  const data = await getStats();
  const usage = data?.contextUsage;
  if (usage) {
    usage.usedTokens = usage.tokens;
    // 刚压缩过：pi 会把 tokens/percent 置 null，直到下一次回复
    usage.afterCompaction = usage.tokens === null;
    usage.estimated = false;
    if (usage.contextWindow > 0) {
      usage.compactAt = Math.max(0, usage.contextWindow - PI_COMPACT_RESERVE);
    }
  }
  return data;
});

ipcMain.handle("pi:budget", () => refreshBudget());

ipcMain.handle("approval:respond", (_event, decision: ApprovalDecision) => {
  resolveApproval(decision.requestId, decision.scope);
});

ipcMain.handle("policy:current", (): PolicyInfo | null => policyService?.info() ?? null);

ipcMain.handle("policy:reload", (): PolicyInfo | null => {
  policyService?.reload();
  return policyService?.info() ?? null;
});

ipcMain.handle("grants:list", (): PersistentGrant[] => grants?.list(workspaceRoot) ?? []);

ipcMain.handle("grants:revoke", (_event, id: string) => grants?.revoke(id) ?? false);

ipcMain.handle("grants:clear", () => {
  grants?.clear();
  return true;
});

ipcMain.handle("audit:read", (_event, limit?: number): AuditEntryView[] =>
  (auditFor(runtimeManager.active?.id)?.read(limit ?? 500) ?? []) as AuditEntryView[],
);

ipcMain.handle("grants:prune", (): number => grants?.prune() ?? 0);

ipcMain.handle("audit:query", (_event, query?: AuditQuery): AuditPage => {
  const page = auditFor(runtimeManager.active?.id)?.query(query ?? {}) ?? { total: 0, items: [] };
  return { total: page.total, items: page.items as AuditEntryView[] };
});

ipcMain.on("app:ready", () => {
  if (!firstInteractiveAt) {
    firstInteractiveAt = Date.now();
    console.log(
      "P3_PERF_STARTUP " + JSON.stringify({ ms: firstInteractiveAt - PROCESS_STARTED_AT }),
    );
  }
});

ipcMain.handle("skills:list", (): SkillInfo[] => (workspaceRoot ? scanSkills(workspaceRoot) : []));

ipcMain.handle("skills:read", (_event, name: string): string | null =>
  workspaceRoot ? readSkill(workspaceRoot, name) : null,
);

ipcMain.handle("skills:set-enabled", (_event, name: string, enabled: boolean): boolean => {
  if (!workspaceRoot) return false;
  const ok = setSkillEnabled(workspaceRoot, name, enabled);
  if (ok) {
    auditLog?.write({
      ts: new Date().toISOString(),
      toolName: "skill",
      ruleId: "skill:" + name,
      decision: "allow",
      scope: enabled ? "enable" : "disable",
      summary: `技能 ${name} ${enabled ? "启用" : "停用"}`,
    });
    // 技能清单在 pi 启动时读取，改动后重启才生效
    defaultRuntime.stop();
    setTimeout(() => defaultRuntime.start(), 300);
  }
  return ok;
});

ipcMain.handle("skills:create", (_event, slug: string, description: string): string | null => {
  if (!workspaceRoot) return null;
  return createSkill(workspaceRoot, slug, description);
});

/* ------------------------------------------------------------------ */
/* MCP（P1）：配置、状态、密钥、信任                                     */
/* ------------------------------------------------------------------ */

ipcMain.handle("mcp:list", () => getMcpService().list());

ipcMain.handle("mcp:check", (_event, name?: string) => getMcpService().check(name));

ipcMain.handle(
  "mcp:save",
  (_event, input: { json?: string; name?: string } | undefined) =>
    getMcpService().save({
      json: String(input?.json ?? ""),
      ...(input?.name ? { name: String(input.name) } : {}),
    }),
);

ipcMain.handle("mcp:remove", (_event, name: string) => getMcpService().remove(String(name)));

ipcMain.handle(
  "mcp:flag",
  (
    _event,
    input:
      | { name?: string; flag?: string; value?: boolean; fingerprint?: string }
      | undefined,
  ) => {
    const flag = input?.flag;
    if (flag !== "enabled" && flag !== "trusted") {
      throw new Error("flag 只能是 enabled 或 trusted");
    }
    return getMcpService().setFlag(
      String(input?.name ?? ""),
      flag,
      Boolean(input?.value),
      typeof input?.fingerprint === "string" ? input.fingerprint : undefined,
    );
  },
);

ipcMain.handle(
  "mcp:secret",
  (_event, input: { name?: string; key?: string; value?: string } | undefined) =>
    getMcpService().setSecret(
      String(input?.name ?? ""),
      String(input?.key ?? ""),
      String(input?.value ?? ""),
    ),
);

ipcMain.handle("mcp:login", async (_event, name: string) => {
  const result = await getMcpService().login(String(name));
  if (result.ok) {
    // 登录令牌写进了 agentDir；运行中的 pi 还拿着旧连接，重启后按新令牌连
    defaultRuntime.stop();
    setTimeout(() => defaultRuntime.start(), 300);
  }
  return result;
});

/* ------------------------------------------------------------------ */
/* 修改 4 · M0：会话是界面身份，槽是执行身份                              */
/* ------------------------------------------------------------------ */

ipcMain.handle("session:board", () => sessionBoard());

/** 当前可见会话的权威值（修改 5 · C5）：新建会话后界面据此把新文件打开 */
ipcMain.handle("session:current", () => ({
  file: currentSessionFile,
  slotId: slotPool.activeSlotId,
  workspace: workspaceRoot,
}));

/**
 * 打开一个会话：找槽 / 绑定 / 必要时挂起最久未用的那个 / 否则排队。
 *
 * 这是「切走不停」的入口——切标签不再走 `switch_session`（那会中断在飞的回合），
 * 而是把目标会话放到它自己的槽上。
 */
ipcMain.handle("session:open", async (_event, file: string): Promise<SessionOpenView> => {
  if (!workspaceRoot) throw new Error("请先打开一个工作区");
  const target = normalizeSessionFile(file) ?? file;
  const t = switchTiming.begin("session-open");

  // 修改 5 · C1：工作区由**会话自己**决定，不再一律用当前视图。
  // 会话文件住在 <工作区>/.omcp/sessions 下；能反查出来就不该拒绝它。
  const ownWorkspace = resolveSessionWorkspace(target);
  if (ownWorkspace && sessionKey(ownWorkspace) !== sessionKey(workspaceRoot)) {
    activateWorkspaceView(ownWorkspace);
    applyPermissionMode();
    switchTiming.mark(t, "view-switch");
  }
  const workspace = ownWorkspace ?? workspaceRoot;

  const outcome = await slotPool.open(target, workspace, {
    visibleSlotId: slotPool.activeSlotId,
  });
  switchTiming.mark(t, "slot-open", { kind: outcome.kind });
  currentSessionFile = target;
  applyPermissionMode();
  pointKernelsAt(target);
  sessionRegistry.clearUnread(target);
  transcriptHub.clearUnread(hubKeyForFile(target));
  // 打开就把"上一轮被中断"的标记收掉：用户已经看到了，红点不该一直挂着
  if (sessionRegistry.get(target)?.state === "interrupted") {
    sessionRegistry.setState(target, "idle");
  }
  if (existsSync(target)) writeWorkspaceState({ lastSessionFile: target });
  switchTiming.end(t, { outcome: outcome.kind });
  return { ...outcome, board: sessionBoard() };
});

/**
 * 另一个工作区的会话列表（修改 5 · C5）。
 *
 * 侧栏展开某个工作区时才调；只允许**已登记**的根（当前 + 最近），
 * 不接受任意路径——否则这就是一个扫描本地任意目录的入口。
 */
ipcMain.handle(
  "sessions:list-in",
  async (
    _event,
    root: string,
  ): Promise<{ sessions: SessionSummary[]; titles: Record<string, string> }> => {
    const resolved = resolve(String(root ?? "").trim());
    if (!resolved) return { sessions: [], titles: {} };
    const known = knownWorkspaceRoots();
    if (!known.some((item) => sessionKey(item) === sessionKey(resolved))) {
      throw new Error("这个工作区没有登记过");
    }
    const key = sessionKey(resolved);
    const cached = sessionListCache.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached.data;
    const sessions = await listSessions(sessionsDirOf(resolved), resolved);
    // 标题跟着一起给：侧栏展开时不能只显示一串 UUID
    const meta = loadSessionMeta(resolved);
    const titles: Record<string, string> = {};
    for (const [name, entry] of Object.entries(meta.sessions ?? {})) {
      if (entry?.title) titles[name] = entry.title;
    }
    const data = { sessions, titles };
    sessionListCache.set(key, { at: Date.now(), data });
    return data;
  },
);

/**
 * 转写快照（修改 4 · M1）。
 *
 * 界面切到一个会话时先问这里：有就整段拿，`cold` 说明中枢里还没有
 * （重启后第一次），由界面用 `get_messages` 重建后再 `seed` 回来。
 */
ipcMain.handle("transcript:snapshot", (_event, file: string) => {
  const target = normalizeSessionFile(file) ?? file;
  return transcriptHub.snapshot(hubKeyForFile(target));
});

/** 子任务并发闸的状态（只读；冒烟与诊断用） */
ipcMain.handle("subagent:gate-state", () => subagentGate.snapshot());

/** 关闭一个会话的槽：进程停掉、会话保留（可以再打开） */
ipcMain.handle("session:close", (_event, file: string): SessionBoardView => {
  const slot = slotPool.slotOfSession(file);
  if (slot) slotPool.closeSlot(slot.id);
  return sessionBoard();
});

/* 旧的 runtime:* 入口（保留给诊断面板与兼容调用） */

ipcMain.handle("runtime:list", () => runtimeManager.list());

ipcMain.handle(
  "runtime:create",
  (_event, input?: { workspaceRoot?: string; sessionFile?: string | null }) => {
    const root = input?.workspaceRoot?.trim() || workspaceRoot;
    if (!root) throw new Error("请先打开一个工作区，再创建 runtime");
    const created = slotPool.spawnFree(root, { visibleSlotId: slotPool.activeSlotId });
    if (sessionDir) created.setSessionDir(sessionDir);
    created.setTrustProject(appSettings.trustProject);
    created.setExtensions(runtimeExtensions);
    created.setThinkingLevel(appSettings.thinkingLevel);
    applyRuntimeServiceEnv(created);
    created.start();
    return runtimeManager.list().find((item) => item.id === created.id) ?? null;
  },
);

ipcMain.handle("runtime:messages", async (_event, id: string) => {
  const target = String(id);
  const runtime = target === "default" ? defaultRuntime : runtimeManager.require(target);
  const timeout = target === "default" ? (piReady ? 30_000 : 3_000) : 10_000;
  const res = await runtime.rpc.request({ type: "get_messages" }, timeout);
  const data = res.data as { messages?: AgentMessage[] } | undefined;
  return data?.messages ?? [];
});

ipcMain.handle("runtime:state", async (_event, id: string) => {
  const target = String(id) === "default" ? defaultRuntime : runtimeManager.require(String(id));
  const res = await target.rpc.request(
    { type: "get_state" },
    String(id) === "default" ? (piReady ? 30_000 : 3_000) : 10_000,
  );
  return (res.data as SessionState | undefined) ?? null;
});

ipcMain.handle("runtime:stats", async (_event, id: string) => {
  const target = String(id) === "default" ? defaultRuntime : runtimeManager.require(String(id));
  const res = await target.rpc.request(
    { type: "get_session_stats" },
    String(id) === "default" ? (piReady ? 30_000 : 3_000) : 10_000,
  );
  return (res.data as SessionStats | undefined) ?? null;
});

ipcMain.handle("runtime:activate", async (_event, id: string) => {
  await slotPool.activate(String(id)).catch(() => undefined);
  const bound = slotPool.get(String(id))?.sessionFile ?? null;
  if (bound) pointKernelsAt(bound);
  return runtimeManager.list();
});

ipcMain.handle("runtime:close", (_event, id: string) => {
  const target = String(id);
  if (target === "default") throw new Error("默认 runtime 不能关闭");
  slotPool.closeSlot(target);
  return runtimeManager.list();
});

ipcMain.handle("mcp:open-config", async () => {
  const service = getMcpService();
  const file = service.configPath();
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{\n  "mcpServers": {}\n}\n', "utf8");
  }
  const error = await shell.openPath(file);
  return { ok: !error, path: file, ...(error ? { error } : {}) };
});

ipcMain.handle("settings:app", (): AppSettingsView => ({ ...appSettings }));

function memoryDirPath(): string {
  return join(app.getPath("userData"), "memory");
}

/** 插件册投影：渲染进程只读；开关的真值在 appSettings.plugins。 */
function pluginViews() {
  return {
    plugins: PLUGINS.map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      key: plugin.key,
      on: pluginEnabled(plugin, appSettings.plugins),
      families: plugin.families.map((family) => ({
        key: family.key,
        name: family.name,
        on: familyEnabled(plugin, family.key, appSettings.plugins),
        tools: family.tools,
      })),
    })),
    enabledKeys: enabledFamilyKeys(appSettings.plugins),
  };
}

ipcMain.handle("plugins:list", () => pluginViews());

ipcMain.handle(
  "plugins:set",
  (_event, pluginId: string, familyKey: string | null, on: boolean) => {
    const plugin = PLUGINS.find((p) => p.id === pluginId);
    if (!plugin) return pluginViews();
    const knownFamily = familyKey ? plugin.families.some((f) => f.key === familyKey) : true;
    if (!knownFamily) return pluginViews();

    const before = enabledFamilyKeys(appSettings.plugins).join("|");
    if (familyKey) appSettings.plugins[familyKey] = on ? "0" : "1";
    else appSettings.plugins[plugin.key] = on ? "0" : "1";
    const after = enabledFamilyKeys(appSettings.plugins).join("|");

    saveAppSettings();
    // 只有工具集真的变了才重启 pi（ADR-045）：改一个不影响启用集的开关不该搬动进程
    if (before !== after) {
      defaultRuntime.setEnv("OMCP_PLUGINS", JSON.stringify(enabledFamilyKeys(appSettings.plugins)));
      defaultRuntime.stop();
      setTimeout(() => defaultRuntime.start(), 300);
    }
    return pluginViews();
  },
);

ipcMain.handle("memory:list", () => readMemoryQueue(memoryDirPath()));

ipcMain.handle("memory:adopt", (_event, id: string) => {
  const dir = memoryDirPath();
  const item = readMemoryQueue(dir).pending.find((e) => e.id === String(id));
  // 技能提案：采纳才落盘（ADR-046）；写不成就不要动队列，否则会出现“已采纳但没文件”
  if (item?.kind === "skill") {
    if (!workspaceRoot) {
      return { ok: false, error: "没有打开工作区，技能无处落盘", queue: readMemoryQueue(dir) };
    }
    const name = String(item.name ?? "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      return { ok: false, error: "技能名不是 kebab-case，拒绝落盘", queue: readMemoryQueue(dir) };
    }
    const body = String(item.body ?? "");
    if (!body.startsWith("---")) {
      return { ok: false, error: "技能正文缺少 frontmatter，拒绝落盘", queue: readMemoryQueue(dir) };
    }
    const target = join(workspaceRoot, ".agents", "skills", name);
    try {
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "SKILL.md"), body, "utf8");
    } catch (err) {
      return { ok: false, error: `写入技能失败：${(err as Error).message}`, queue: readMemoryQueue(dir) };
    }
  }
  const res = adoptMemory(dir, String(id));
  return { ...res, queue: readMemoryQueue(dir) };
});

ipcMain.handle("memory:reject", (_event, id: string) => {
  const res = rejectMemory(memoryDirPath(), String(id));
  return { ...res, queue: readMemoryQueue(memoryDirPath()) };
});

ipcMain.handle(
  "settings:detail",
  (): AppSettingsDetail => ({
    provider: supervisor.getProvider(),
    model: supervisor.getModel(),
    sessionLimit: budget.sessionLimit,
    dailyLimit: budget.dailyLimit,
    policyPath: settingsPolicyPath ?? "",
    pythonPath: appSettings.pythonPath,
    rPath: appSettings.rPath,
    updateRepo: appSettings.updateRepo,
    trustProject: appSettings.trustProject,
    piConfigDir: appSettings.piConfigDir,
    grantTtlDays: appSettings.grantTtlDays,
    readonlyNotebook: appSettings.readonlyNotebook,
    permissionMode: appSettings.permissionMode,
    thinkingLevel: appSettings.thinkingLevel,
    maxRuntimes: appSettings.maxRuntimes,
    runtimeIdleMinutes: appSettings.runtimeIdleMinutes,
  }),
);

ipcMain.handle(
  "settings:detail:set",
  async (_event, patch: Partial<AppSettingsDetail>): Promise<AppSettingsDetail> => {
    const beforeProvider = supervisor.getProvider();
    const beforeModel = supervisor.getModel();
    let restartKernel = false;

    if (typeof patch.provider === "string" && patch.provider.trim()) {
      appSettings.provider = patch.provider.trim();
    }
    if (typeof patch.model === "string" && patch.model.trim()) {
      appSettings.model = patch.model.trim();
    }
    if (typeof patch.sessionLimit === "number" && Number.isFinite(patch.sessionLimit)) {
      budget.sessionLimit = Math.max(0, patch.sessionLimit);
      appSettings.sessionLimit = budget.sessionLimit;
    }
    if (typeof patch.dailyLimit === "number" && Number.isFinite(patch.dailyLimit)) {
      budget.dailyLimit = Math.max(0, patch.dailyLimit);
      appSettings.dailyLimit = budget.dailyLimit;
    }
    if (typeof patch.policyPath === "string") {
      settingsPolicyPath = patch.policyPath.trim() || undefined;
      policyService?.reload();
    }
    let restartRKernel = false;
    if (typeof patch.pythonPath === "string") {
      const next = patch.pythonPath.trim();
      if (next !== appSettings.pythonPath) {
        appSettings.pythonPath = next;
        pythonKernel?.setPythonPath(next);
        restartKernel = true;
      }
    }
    if (typeof patch.rPath === "string") {
      const next = patch.rPath.trim();
      if (next !== appSettings.rPath) {
        appSettings.rPath = next;
        rKernel?.setRPath(next);
        restartRKernel = true;
      }
    }
    if (typeof patch.updateRepo === "string") appSettings.updateRepo = patch.updateRepo.trim();
    if (typeof patch.piConfigDir === "string" && patch.piConfigDir.trim() !== appSettings.piConfigDir) {
      appSettings.piConfigDir = patch.piConfigDir.trim();
      defaultRuntime.setEnv("PI_CODING_AGENT_DIR", appSettings.piConfigDir);
      defaultRuntime.stop();
      setTimeout(() => defaultRuntime.start(), 300);
    }
    if (typeof patch.trustProject === "boolean" && patch.trustProject !== appSettings.trustProject) {
      appSettings.trustProject = patch.trustProject;
      defaultRuntime.setTrustProject(patch.trustProject);
      defaultRuntime.stop();
      setTimeout(() => defaultRuntime.start(), 300);
    }
    if (typeof patch.grantTtlDays === "number") {
      appSettings.grantTtlDays = Math.max(0, Math.min(3650, Math.floor(patch.grantTtlDays)));
    }
    if (typeof patch.readonlyNotebook === "boolean") {
      appSettings.readonlyNotebook = patch.readonlyNotebook;
    }
    if (
      patch.permissionMode === "deny-risky" ||
      patch.permissionMode === "ask-risky" ||
      patch.permissionMode === "allow-all"
    ) {
      appSettings.permissionMode = patch.permissionMode;
      // 当前会话若没有单独覆盖，立即生效；有覆盖时保持会话档
      if (!sessionPermissionOverride()) policyService?.setMode(appSettings.permissionMode);
    }
    if (typeof patch.maxRuntimes === "number" && Number.isFinite(patch.maxRuntimes)) {
      appSettings.maxRuntimes = Math.max(1, Math.min(4, Math.floor(patch.maxRuntimes)));
      runtimeManager.setMaxRuntimes(appSettings.maxRuntimes);
      slotPool.setMaxSlots(appSettings.maxRuntimes);
    }
    if (
      typeof patch.runtimeIdleMinutes === "number" &&
      Number.isFinite(patch.runtimeIdleMinutes)
    ) {
      appSettings.runtimeIdleMinutes = Math.max(
        1,
        Math.min(1440, Math.floor(patch.runtimeIdleMinutes)),
      );
    }
    if (isThinkingLevel(patch.thinkingLevel)) {
      appSettings.thinkingLevel = patch.thinkingLevel;
      defaultRuntime.setThinkingLevel(patch.thinkingLevel);
      await rpc
        .request({ type: "set_thinking_level", level: patch.thinkingLevel })
        .catch(() => null);
    }

    const providerChanged = appSettings.provider !== beforeProvider;
    const modelChanged = appSettings.model !== beforeModel;
    if (providerChanged || modelChanged) {
      defaultRuntime.setModel(appSettings.provider, appSettings.model);
      try {
        if (workspaceRoot) {
          writeFileSync(
            join(workspaceRoot, ".omcp", "settings.json"),
            JSON.stringify({ provider: appSettings.provider, model: appSettings.model }, null, 2) + "\n",
            "utf8",
          );
        }
      } catch {
        // 工作区不可写时只影响下次启动
      }
      if (providerChanged) {
        defaultRuntime.stop();
        setTimeout(() => defaultRuntime.start(), 300);
      } else {
        const res = await rpc
          .request({ type: "set_model", provider: appSettings.provider, modelId: appSettings.model })
          .catch(() => null);
        if (!res?.success) {
          defaultRuntime.stop();
          setTimeout(() => defaultRuntime.start(), 300);
        }
      }
    }

    saveAppSettings();
    if (restartKernel) void pythonKernel?.restart().catch(() => undefined);
    if (restartRKernel) void rKernel?.restart().catch(() => undefined);

    return {
      provider: supervisor.getProvider(),
      model: supervisor.getModel(),
      sessionLimit: budget.sessionLimit,
      dailyLimit: budget.dailyLimit,
      policyPath: settingsPolicyPath ?? "",
      pythonPath: appSettings.pythonPath,
      rPath: appSettings.rPath,
      updateRepo: appSettings.updateRepo,
      trustProject: appSettings.trustProject,
      piConfigDir: appSettings.piConfigDir,
      grantTtlDays: appSettings.grantTtlDays,
      readonlyNotebook: appSettings.readonlyNotebook,
      permissionMode: appSettings.permissionMode,
      thinkingLevel: appSettings.thinkingLevel,
      maxRuntimes: appSettings.maxRuntimes,
      runtimeIdleMinutes: appSettings.runtimeIdleMinutes,
    };
  },
);

ipcMain.handle("permission:get", (): PermissionState => permissionState());

ipcMain.handle(
  "permission:set",
  (_event, mode: PermissionMode, asDefault: boolean): PermissionState => {
    if (mode !== "deny-risky" && mode !== "ask-risky" && mode !== "allow-all") {
      return permissionState();
    }
    // 会话级：写进这一段自己的 meta（**它自己所在的工作区**，不是当前视图的）
    if (currentSessionFile) {
      const key = sessionMetaKey(currentSessionFile);
      const root = resolveSessionWorkspace(currentSessionFile) ?? workspaceRoot;
      if (key && root) patchSessionMeta(root, key, { permissionMode: mode });
    } else {
      // 没有会话（空态屏）：直接改默认
      appSettings.permissionMode = mode;
      saveAppSettings();
    }
    if (asDefault) {
      appSettings.permissionMode = mode;
      saveAppSettings();
    }
    applyPermissionMode("user");
    return permissionState();
  },
);

ipcMain.handle("update:check", (): Promise<UpdateCheckResult> =>
  checkForUpdate(app.getVersion(), appSettings.updateRepo),
);

ipcMain.handle("diag:export", async (): Promise<string | null> => {
  if (!workspaceRoot) return null;
  const info = policyService?.info() ?? { mode: "ask" as const, source: "default" as const, path: null, errors: [] };
  let settingsSnapshot: Record<string, unknown> = {};
  try {
    settingsSnapshot = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  } catch {
    settingsSnapshot = {};
  }
  const piInfo = await piRuntimeInfo();
  return buildDiagnosticZip(
    {
      pi: {
        origin: piInfo.origin,
        entry: piInfo.entry,
        expected: piInfo.expected,
        actual: piInfo.actual,
        configDir: piInfo.configDir,
        isolated: piInfo.configIsolated,
        systemPath: piInfo.system.path,
        systemVersion: piInfo.system.version,
      },
      version: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node,
      platform: osPlatform(),
      arch: osArch(),
      workspace: workspaceRoot,
      policy: {
        mode: info.mode,
        source: info.source,
        path: info.path,
        errors: info.errors,
      },
      grants: grants?.list(workspaceRoot).length ?? 0,
      auditEntries: auditLog?.query({ limit: 1 }).total ?? 0,
      settings: settingsSnapshot,
      pythonPath: pythonKernel?.pythonPath ?? "",
      rKernel: "sci-ir (Rterm.exe)",
      auditTail: auditLog?.read(100) ?? [],
      appLogTail: tailFile(join(logsDir, "app.jsonl"), 200),
    },
    join(app.getPath("userData"), "exports"),
  );
});

ipcMain.handle(
  "settings:app:set",
  (_event, patch: Partial<AppSettingsView>): AppSettingsView => {
    if (typeof patch.grantTtlDays === "number" && Number.isFinite(patch.grantTtlDays)) {
      appSettings.grantTtlDays = Math.max(0, Math.min(3650, Math.floor(patch.grantTtlDays)));
    }
    if (typeof patch.readonlyNotebook === "boolean") {
      appSettings.readonlyNotebook = patch.readonlyNotebook;
    }
    if (
      patch.permissionMode === "deny-risky" ||
      patch.permissionMode === "ask-risky" ||
      patch.permissionMode === "allow-all"
    ) {
      appSettings.permissionMode = patch.permissionMode;
      // 当前会话若没有单独覆盖，立即生效；有覆盖时保持会话档
      if (!sessionPermissionOverride()) policyService?.setMode(appSettings.permissionMode);
    }
    saveAppSettings();
    return { ...appSettings };
  },
);

ipcMain.handle("audit:export", (): string | null => {
  const runtimeId = runtimeManager.active?.id;
  const root =
    runtimeId && runtimeId !== "default"
      ? runtimeManager.get(runtimeId)?.workspace ?? workspaceRoot
      : workspaceRoot;
  if (!root) return null;
  const entries = (auditFor(runtimeId)?.read(5000) ?? []) as AuditEntryView[];
  const dir = join(app.getPath("userData"), "exports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = runtimeId && runtimeId !== "default" ? "-" + runtimeId : "";
  const file = join(dir, "audit-" + stamp + suffix + ".csv");
  const cell = (value: unknown) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
  const header = ["ts", "toolName", "ruleId", "decision", "scope", "summary", "sessionId"].join(",");
  const body = entries
    .map((e) =>
      [e.ts, e.toolName, e.ruleId, e.decision, e.scope ?? "", e.summary, e.sessionId ?? ""]
        .map(cell)
        .join(","),
    )
    .join("\n");
  writeFileSync(file, header + "\n" + body + "\n", "utf8");
  return file;
});

/**
 * 旧入口 `pi:switch-session`（修改 5 · C7）：**降级为槽池的转发**。
 *
 * 原来它调 pi 的 `switch_session`——那个动作会**取消在飞的一轮**，
 * 与「切走不停」直接冲突。现在语义改成「把这段会话放到它自己的槽上」，
 * 与 `session:open` 同一条路：同一工作区换会话不再杀进程，
 * 跨工作区也不再要求先把视图切过去。
 *
 * 保留这个 handler 只为兼容旧调用方（界面已改走 `session:open`）。
 */
ipcMain.handle("pi:switch-session", async (_event, file: string, _runtimeId?: string) => {
  invalidateStats();
  const target = normalizeSessionFile(file) ?? file;
  const workspace = resolveSessionWorkspace(target) ?? workspaceRoot;
  if (!workspace) return false;
  if (sessionKey(workspace) !== sessionKey(workspaceRoot)) activateWorkspaceView(workspace);
  const outcome = await slotPool.open(target, workspace, {
    visibleSlotId: slotPool.activeSlotId,
  });
  if (outcome.kind === "queued") return false;
  currentSessionFile = target;
  applyPermissionMode();
  pointKernelsAt(target);
  writeWorkspaceState({ lastSessionFile: target });
  void resetBudgetBaseline(outcome.slotId ?? "default");
  const key = sessionMetaKey(target);
  if (sessionKey(workspace) === sessionKey(workspaceRoot) && key && existsSync(join(sessionDir, key))) {
    patchSessionMeta(workspaceRoot, key, { lastOpenedAt: new Date().toISOString() });
  }
  return true;
});

async function runSelftestMode(): Promise<void> {
  const js = <T,>(code: string): Promise<T> =>
    win!.webContents.executeJavaScript(code) as Promise<T>;
  const body = () => js<string>("document.body.innerText");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const waitPiReady = async (): Promise<void> => {
    for (let i = 0; i < 240; i++) {
      const ready = await js<boolean>("window.api.isPiReady().then((v) => v === true)").catch(
        () => false,
      );
      if (ready === true) return;
      await sleep(250);
    }
  };

  try {
    if (SELFTEST_MODE === "perf") {
      await waitPiReady();
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 240; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };
      const startupMs = firstInteractiveAt ? firstInteractiveAt - PROCESS_STARTED_AT : null;

      const latencies: number[] = [];
      for (let round = 0; round < 5; round++) {
        const started = Date.now();
        const measured = new Promise<number>((resolve) => {
          tokenProbe = { startedAt: started, resolve };
        });
        await js('window.api.prompt("只回复：ok")');
        const ms = await Promise.race([measured, sleep(60_000).then(() => -1)]);
        latencies.push(ms);
        await waitIdle();
        await sleep(400);
      }
      tokenProbe = null;

      const kernelStartAt = Date.now();
      await js('window.api.restartKernel("python")');
      const kernelRestartMs = Date.now() - kernelStartAt;

      const runStartAt = Date.now();
      let failures = 0;
      for (let i = 0; i < 50; i++) {
        const ok = await js<boolean>(`window.api.runCell("perf${i}", "x = ${i}")`);
        if (!ok) failures += 1;
      }
      const fiftyMs = Date.now() - runStartAt;

      const memMb = Math.round(
        app.getAppMetrics().reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024,
      );
      const sorted = [...latencies].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? -1;
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? -1;

      console.log(
        "P3_PERF " +
          JSON.stringify({
            startupMs,
            firstTokenMs: latencies,
            p50,
            p95,
            kernelStartMs: pythonKernel?.startMs ?? null,
            kernelRestartMs,
            fiftyRunsMs: fiftyMs,
            fiftyFailures: failures,
            memMb,
          }),
      );
      await turnTrace.flush();
      app.quit();
    }

    if (SELFTEST_MODE === "kernelbench") {
      // 在页面内直接循环调用，排除 executeJavaScript 每格一次的往返开销
      await js('window.api.runCell("kb-warm", "x = 0")');
      const r = await js<{ ms: number; fail: number; first10: number; last10: number; p50: number; p95: number }>(
        `(async () => {
          const t0 = performance.now();
          const lat = [];
          let fail = 0;
          for (let i = 0; i < 50; i++) {
            const a = performance.now();
            const ok = await window.api.runCell("kb" + i, "x = " + i);
            lat.push(performance.now() - a);
            if (!ok) fail++;
          }
          const sum = (xs) => xs.reduce((a, b) => a + b, 0);
          const sorted = [...lat].sort((a, b) => a - b);
          const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
          return {
            ms: Math.round(performance.now() - t0),
            fail,
            first10: Math.round(sum(lat.slice(0, 10))),
            last10: Math.round(sum(lat.slice(-10))),
            p50: Math.round(q(0.5)),
            p95: Math.round(q(0.95)),
          };
        })()`,
      );
      console.log("P3_KERNELBENCH " + JSON.stringify(r));
      app.quit();
    }

    if (SELFTEST_MODE === "sidebarcheck") {
      const r = await js<unknown>(
        `(async () => {
          const text = document.body.innerText;
          const more = document.querySelector(".session-more");
          more?.click();
          await new Promise((r) => setTimeout(r, 50));
          const menuItems = [...document.querySelectorAll(".session-menu [role=menuitem]")].map(
            (b) => b.textContent?.trim(),
          );
          return {
            hasNewTask: !!document.querySelector(".side-new"),
            hasWorkspaceHead: !!document.querySelector(".side-ws-head"),
            hasTabs: !!document.querySelector(".side-tabs"),
            hasOldActions: !!document.querySelector(".side-actions"),
            sessionRows: document.querySelectorAll(".session").length,
            wsGroups: document.querySelectorAll(".ws-group").length,
            hasMore: !!more,
            menuItems,
            archivedEntry: text.includes("已归档"),
            hasTreeTab: text.includes("树"),
          };
        })()`,
      );
      console.log("P3_SIDEBAR " + JSON.stringify(r));
      app.quit();
    }

    if (SELFTEST_MODE === "layoutcheck") {
      const r = await js<unknown>(
        `(async () => {
          const sw = document.querySelector(".dock-switch");
          const dock = document.querySelector(".dock");
          const side = document.querySelector(".sidebar");
          const text = document.body.innerText;
          const width = (el) => (el ? Math.round(el.getBoundingClientRect().width) : -1);
          const before = {
            hasSwitch: !!sw,
            switchText: sw?.textContent?.trim() || "",
            hasLeftCollapse: text.includes("收起左栏"),
            hasRightCollapse: text.includes("收起右坞"),
            hasRail: !!document.querySelector(".dock-rail"),
            hasClose: !!document.querySelector('[aria-label="关闭面板"]'),
            sidebarWidth: width(side),
            dockWidth: width(dock),
          };
          sw?.click();
          await new Promise((r) => setTimeout(r, 80));
          const closed = {
            dockWidth: width(document.querySelector(".dock")),
            switchText: document.querySelector(".dock-switch")?.textContent?.trim() || "",
            hasRail: !!document.querySelector(".dock-rail"),
            sidebarWidth: width(document.querySelector(".sidebar")),
          };
          document.querySelector(".dock-switch")?.click();
          await new Promise((r) => setTimeout(r, 80));
          return { before, closed, reopened: width(document.querySelector(".dock")) };
        })()`,
      );
      console.log("P3_LAYOUT " + JSON.stringify(r));
      app.quit();
    }

    if (SELFTEST_MODE === "uploadcheck") {
      const inside = join(workspaceRoot, "data", "raw", "upload-inside.csv");
      mkdirSync(dirname(inside), { recursive: true });
      const nl = String.fromCharCode(10);
      writeFileSync(inside, "a,b" + nl + "1,2" + nl, "utf8");
      const outside = join(app.getPath("temp"), `omcp-upload-${Date.now()}.csv`);
      writeFileSync(outside, "x,y" + nl + "3,4" + nl, "utf8");
      const res = await js<{ ok: boolean; files: string[]; error?: string }>(
        `window.api.importUploads(${JSON.stringify([inside, outside])}, "selftest-upload")`,
      );
      const audit = (auditLog?.read(10) ?? []).filter((e) => e.toolName === "upload");
      const ui = await js<{ hasTrigger: boolean; label: string }>(
        `({ hasTrigger: !!document.querySelector(".upload-trigger"), label: document.querySelector(".upload-trigger")?.getAttribute("aria-label") || "" })`,
      );
      console.log(
        "P3_UPLOAD " +
          JSON.stringify({
            res,
            insideExists: existsSync(inside),
            copiedExists: res.files[1] ? existsSync(join(workspaceRoot, res.files[1])) : false,
            audit: audit.slice(-2),
            ui,
          }),
      );
      app.quit();
    }

    if (SELFTEST_MODE === "ready") {
      // 验证就绪门：未就绪时应立刻返回可读错误，而不是等 30 秒
      const t0 = Date.now();
      const res = await js<{ ok: boolean; error?: string }>('window.api.prompt("只回复：ok")');
      const ready = await js<boolean>("window.api.isPiReady()");
      console.log("P3_READY " + JSON.stringify({ ...res, ms: Date.now() - t0, ready }));
      app.quit();
    }

    if (SELFTEST_MODE === "perflong") {
      // 长回复基线：量 ipcEvents / ipcSent 的合并率与首 token
      await waitPiReady();
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 600; i++) {
          try {
            const st = await js<{ isStreaming?: boolean } | null>("window.api.getState()");
            if (st && !st.isStreaming) return;
          } catch {
            // pi 还没就绪，继续等
          }
          await sleep(300);
        }
      };
      await waitIdle();
      await js("window.__omcpPerfEnabled = true");
      await js(
        'window.api.prompt("请写一段约 1200 字的中文说明，分 6 段，每段一个小标题；只输出正文，不要使用任何工具。")',
      );
      await sleep(800);
      await waitIdle();
      await sleep(500);
      const clientPerf = await js<unknown>("window.__omcpPerf ?? null");
      console.log("P3_PERF_CLIENT " + JSON.stringify(clientPerf));
      await turnTrace.flush();
      const perfFile = join(workspaceRoot, ".omcp", "logs", "perf.jsonl");
      const lines = existsSync(perfFile)
        ? readFileSync(perfFile, "utf8")
            .trim()
            .split(String.fromCharCode(10))
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
      console.log("P3_PERF_LONG " + (lines.at(-1) ?? "{}"));
      app.quit();
    }

    if (SELFTEST_MODE === "a2a5") {
      const demoFile = join(workspaceRoot, "data", "raw", "demo.csv");
      const fig1 = join(workspaceRoot, "figures", "a1-boxplot.png");
      const fig2 = join(workspaceRoot, "figures", "a2-boxplot-w8.png");
      const table5 = join(workspaceRoot, "results", "tables", "a5-export.csv");

      const a1Code = [
        "import pandas as pd",
        "import matplotlib.pyplot as plt",
        'df = pd.read_csv("data/raw/demo.csv")',
        'stats = df.groupby("group")["value"].agg(["mean","median","count"])',
        "print(stats)",
        'df.boxplot(column="value", by="group")',
        'plt.suptitle("")',
        'plt.savefig("figures/a1-boxplot.png", dpi=150)',
        "plt.show()",
        'stats.to_csv("results/tables/a1-stats.csv")',
      ].join("\n");
      const a1 = await js<boolean>(`window.api.runCell("a1final", ${JSON.stringify(a1Code)})`);
      await sleep(1200);
      const mtime1 = existsSync(fig1) ? statSync(fig1).mtimeMs : 0;

      // A2：不重新读 csv，改字号与图宽重画（依赖同一内核里的 df）
      const a2Code = [
        "plt.rcParams.update({'font.size': 12})",
        "fig, ax = plt.subplots(figsize=(8, 5))",
        'df.boxplot(column="value", by="group", ax=ax)',
        'plt.suptitle("")',
        'plt.savefig("figures/a2-boxplot-w8.png", dpi=150)',
        "plt.show()",
        "print('rows=' + str(len(df)))",
      ].join("\n");
      const a2 = await js<boolean>(`window.api.runCell("a2final", ${JSON.stringify(a2Code)})`);
      await sleep(1200);
      const vars = await js<string[]>('window.api.getVariables("python")');
      const oldKept = existsSync(fig1) && Math.abs(statSync(fig1).mtimeMs - mtime1) < 1;

      // A5：把统计写成 csv 并核对数字
      const a5Code = [
        "stats = df.groupby('group')['value'].agg(['mean','median','count'])",
        "stats.to_csv('results/tables/a5-export.csv')",
        "print('a5 ok')",
      ].join("\n");
      const a5 = await js<boolean>(`window.api.runCell("a5final", ${JSON.stringify(a5Code)})`);
      await sleep(800);

      let csvOk = false;
      let csvRows = 0;
      try {
        const csv = readFileSync(table5, "utf8").trim().split(/\r?\n/);
        csvRows = csv.length - 1;
        const means = new Map<string, number>();
        const raw = readFileSync(demoFile, "utf8").split(/\r?\n/).slice(1).filter(Boolean);
        const acc = new Map<string, { sum: number; n: number }>();
        for (const line of raw) {
          const [group, value] = line.split(",");
          const item = acc.get(group) ?? { sum: 0, n: 0 };
          item.sum += Number(value);
          item.n += 1;
          acc.set(group, item);
        }
        for (const [g, v] of acc) means.set(g, v.sum / v.n);
        csvOk = csv.slice(1).every((line) => {
          const [group, mean] = line.split(",");
          const expected = means.get(group);
          return expected !== undefined && Math.abs(Number(mean) - expected) < 0.01;
        });
      } catch {
        csvOk = false;
      }

      console.log(
        "P3_ACCEPT_A2A5 " +
          JSON.stringify({
            a1,
            a1Figure: existsSync(fig1),
            a1Table: existsSync(join(workspaceRoot, "results", "tables", "a1-stats.csv")),
            a2,
            a2Figure: existsSync(fig2),
            a2OldFigureKept: oldKept,
            dfKeptInKernel: vars.includes("df"),
            a5,
            a5Table: existsSync(table5),
            a5Rows: csvRows,
            a5NumbersMatch: csvOk,
          }),
      );
    }

    if (SELFTEST_MODE === "p42") {
      const before = await js<AppSettingsDetail>("window.api.getSettingsDetail()");
      await js(
        'window.api.updateSettingsDetail({ updateRepo: "electron/electron", sessionLimit: 1.5 })',
      );
      const after = await js<AppSettingsDetail>("window.api.getSettingsDetail()");
      const update = await js<UpdateCheckResult>("window.api.checkUpdate()");
      const diag = await js<string | null>("window.api.exportDiagnostics()");

      // 设置页渲染（按文字选中，避免 tab 顺序变化导致点错）
      await js('[...document.querySelectorAll(".viewtabs button")].find(function(b){return b.textContent.trim()==="设置";}).click()');
      await sleep(900);
      const sections = await js<number>('document.querySelectorAll(".perm-card").length');
      const inputs = await js<number>('document.querySelectorAll(".perm-form input").length');

      // 还原
      await js('window.api.updateSettingsDetail({ updateRepo: "", sessionLimit: 1 })');
      const restored = await js<AppSettingsDetail>("window.api.getSettingsDetail()");

      console.log(
        "P3_SELFTEST_P42 " +
          JSON.stringify({
            beforeRepo: before.updateRepo,
            afterRepo: after.updateRepo,
            sessionLimitApplied: after.sessionLimit === 1.5,
            restoredRepo: restored.updateRepo,
            restoredLimit: restored.sessionLimit,
            updateConfigured: update.configured,
            updateLatest: update.latest ?? null,
            updateError: update.error ?? null,
            hasUpdateField: typeof update.hasUpdate === "boolean",
            diagPath: diag,
            diagExists: diag ? existsSync(diag) : false,
            settingsSections: sections,
            settingsInputs: inputs,
          }),
      );
    }

    if (SELFTEST_MODE === "a4") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 120; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };
      await js('window.api.prompt("只回复：a4-ok")');
      await waitIdle();
      const snapshot = () =>
        js<{ state: SessionState; messages: AgentMessage[]; stats: SessionStats }>(
          "Promise.all([window.api.getState(), window.api.getMessages(), window.api.getStats()])" +
            ".then(([state, messages, stats]) => ({ state, messages, stats }))",
        );
      const before = await snapshot();
      const pid = supervisor.current?.pid ?? null;

      // 强杀：不设置 stopping，让 supervisor 走自动重启
      if (pid) {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", detached: true }).unref();
      }
      let restarted = false;
      let sawBanner = false;
      for (let i = 0; i < 120; i++) {
        if (!sawBanner) {
          sawBanner = await js<boolean>('!!document.querySelector(".banner.warn")');
        }
        if (supervisor.current?.pid && supervisor.current.pid !== pid) {
          restarted = true;
          break;
        }
        await sleep(100);
      }
      await sleep(3000);
      const after = await snapshot();
      const banner = await js<boolean>('!!document.querySelector(".banner.warn")');
      console.log(
        "P3_SELFTEST_A4 " +
          JSON.stringify({
            killedPid: pid,
            restarted,
            sameSession: before.state.sessionFile === after.state.sessionFile,
            beforeMessages: before.messages.length,
            afterMessages: after.messages.length,
            messagesKept: after.messages.length >= before.messages.length,
            beforeCost: before.stats.cost,
            afterCost: after.stats.cost,
            costNotReset: after.stats.cost >= before.stats.cost,
            sawBanner,
            bannerAfter: banner,
          }),
      );
    }

    if (SELFTEST_MODE === "piiso") {
      const before = (await js<PiRuntimeInfo>("window.api.getPiInfo()")) as PiRuntimeInfo;
      await js(
        "window.api.updateSettingsDetail({ piConfigDir: " +
          JSON.stringify(before.defaultIsolatedDir) +
          " })",
      );
      await sleep(2500);
      const isolated = (await js<PiRuntimeInfo>("window.api.getPiInfo()")) as PiRuntimeInfo;
      await js('window.api.updateSettingsDetail({ piConfigDir: "" })');
      await sleep(2500);
      const restored = (await js<PiRuntimeInfo>("window.api.getPiInfo()")) as PiRuntimeInfo;
      console.log(
        "P3_SELFTEST_PIISO " +
          JSON.stringify({
            before: { isolated: before.configIsolated, dir: before.configDir },
            isolated: { isolated: isolated.configIsolated, dir: isolated.configDir },
            restored: { isolated: restored.configIsolated, dir: restored.configDir },
          }),
      );
    }

    if (SELFTEST_MODE === "piinfo") {
      const info = (await js<PiRuntimeInfo>("window.api.getPiInfo()")) as PiRuntimeInfo;
      console.log("P3_SELFTEST_PIINFO " + JSON.stringify(info));
    }

    if (SELFTEST_MODE === "rc") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 120; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };
      // 临时关掉 run_code 审批，专注验证“工具本身能被调用”
      const policyFile = join(workspaceRoot, ".omcp", "policy.json");
      const original = existsSync(policyFile) ? readFileSync(policyFile, "utf8") : null;
      writeFileSync(
        policyFile,
        JSON.stringify({ version: 1, runCode: { requireApproval: false } }, null, 2) + "\n",
        "utf8",
      );
      policyService?.reload();
      await sleep(600);

      await js('window.api.prompt("请用 run_code 执行这段代码：print(41 + 1)，然后只回复输出结果。")');
      await waitIdle();
      await sleep(1500);

      let newest: string | null = null;
      let mtime = 0;
      try {
        for (const name of readdirSync(sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(sessionDir, name);
          const t = statSync(file).mtimeMs;
          if (t > mtime) {
            mtime = t;
            newest = file;
          }
        }
      } catch {
        newest = null;
      }
      const text = newest ? readFileSync(newest, "utf8") : "";
      const usedRunCode = text.includes('"name":"run_code"') || text.includes('"toolName":"run_code"');
      const got42 = text.includes("42");

      if (original === null) {
        try {
          (await import("node:fs")).unlinkSync(policyFile);
        } catch {
          // ignore
        }
      } else {
        writeFileSync(policyFile, original, "utf8");
      }
      policyService?.reload();

      console.log(
        "P3_SELFTEST_RC " + JSON.stringify({ usedRunCode, got42, session: newest ? newest.split(/[\/]/).pop() : null }),
      );
    }

    if (SELFTEST_MODE === "p54") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 240; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };
      const newestSessionText = (): string => {
        let newest: string | null = null;
        let mtime = 0;
        try {
          for (const name of readdirSync(sessionDir)) {
            if (!name.endsWith(".jsonl")) continue;
            const file = join(sessionDir, name);
            const t = statSync(file).mtimeMs;
            if (t > mtime) {
              mtime = t;
              newest = file;
            }
          }
        } catch {
          return "";
        }
        return newest ? readFileSync(newest, "utf8") : "";
      };

      // ---------- A. 技能 → 分析 → CSV ----------
      const skillDir = join(workspaceRoot, ".agents", "skills", "desc-stats");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: desc-stats\ndescription: 按分组做描述统计并输出 CSV。用户说“描述统计”“分组汇总”时使用。\n---\n\n# 描述统计\n\n1. 读取指定数据文件。\n2. 按分组列计算 mean / median / count。\n3. 打印表格。\n4. 写入 results/tables/desc-stats.csv。\n",
        "utf8",
      );
      const restoredSession = currentSessionFile;
      currentSessionFile = null;
      defaultRuntime.setSessionFile(null);
      const beforeTrust = appSettings.trustProject;
      appSettings.trustProject = true;
      defaultRuntime.setTrustProject(true);
      defaultRuntime.stop();
      await sleep(600);
      defaultRuntime.start();
      await sleep(2500);

      const e2eCsv = join(workspaceRoot, "results", "tables", "e2e-stats.csv");
      try {
        (await import("node:fs")).unlinkSync(e2eCsv);
      } catch {
        // 不存在就算了
      }
      const e2eStart = new Date().toISOString();
      await js(
        'window.api.prompt("请使用 desc-stats 技能：用 bash 执行 python 读取 data/raw/demo.csv，按 group 计算 mean/median/count，写到 results/tables/e2e-stats.csv，完成后只回复 done。不要使用 run_code。")',
      );
      for (let i = 0; i < 150; i++) {
        await sleep(1000);
        if (existsSync(e2eCsv)) break;
      }
      await sleep(1000);
      const sessionText = newestSessionText();

      // ---------- B. 路线：3 步 + 导出 ----------
      const routeDoc = {
        version: 1,
        updatedAt: new Date().toISOString(),
        steps: [
          { id: "e1", title: "按技能执行描述统计", purpose: "产出分组均值", inputs: "data/raw/demo.csv", outputs: "results/tables/e2e-stats.csv", status: "done", evidence: "limited" },
          { id: "e2", title: "画箱线图", purpose: "看组间分布", inputs: "results/tables/e2e-stats.csv", outputs: "figures/a1-boxplot.png", status: "done", evidence: "limited" },
          { id: "e3", title: "导出路线", purpose: "留给报告", inputs: ".omcp/route.json", outputs: "results/reports/", status: "done", evidence: "none" },
        ],
      };
      const savedRoute = saveRoute(workspaceRoot, routeDoc);
      const exported = exportRoute(workspaceRoot);
      const exportText = exported.path ? readFileSync(exported.path, "utf8") : "";
      const exportHasAll = routeDoc.steps.every((x) => exportText.includes(x.title));

      // ---------- C. 视觉：mock 端点 + 纯文本分支 ----------
      const { createServer } = await import("node:http");
      const tiny =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const mock = createServer((req, res) => {
        if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ choices: [{ message: { content: "MOCK-VISION 标题：E2E 图；趋势：HS 最低。" } }] }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
      const addr = mock.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const beforeVision = { baseUrl: appSettings.visionBaseUrl, model: appSettings.visionModel };
      appSettings.visionBaseUrl = `http://127.0.0.1:${port}`;
      appSettings.visionModel = "mock-vision";
      forceTextOnlyForTest = true;
      const brokerDesc = await describeForVision(tiny, "image/png");
      forceTextOnlyForTest = false;
      const visionOk = Boolean(brokerDesc.text && brokerDesc.text.includes("MOCK-VISION"));
      appSettings.visionBaseUrl = beforeVision.baseUrl;
      appSettings.visionModel = beforeVision.model;
      await new Promise<void>((resolve) => mock.close(() => resolve()));

      // ---------- D. 方案期门 + 拒绝理由回模型 ----------
      await js("window.api.setPlanMode(true)");
      const deniedWrite = policyService?.decide("write", { path: "results/tables/reason.csv", content: "1" });
      const deniedBash = policyService?.decide("bash", { command: "echo 1 > results/tables/reason.csv" });
      await waitIdle();
      const reasonBefore = newestSessionText().length;
      let reasonSent = false;
      for (let i = 0; i < 8 && !reasonSent; i++) {
        reasonSent = await js<boolean>(
          'window.api.prompt("请直接执行这条 bash 命令，不要改用别的方式：echo 1 > results/tables/reason.csv")',
        );
        if (!reasonSent) await sleep(1000);
      }
      let reasonSeen = false;
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        const text = newestSessionText();
        if (text.includes("方案期只读")) {
          reasonSeen = true;
          break;
        }
        if (text.length > reasonBefore + 200 && i > 10) break;
      }

      const planFile = join(workspaceRoot, ".omcp", "plans", "p54.md");
      mkdirSync(join(workspaceRoot, ".omcp", "plans"), { recursive: true });
      writeFileSync(planFile, "# P5.4 方案\n\n1. 统计\n", "utf8");
      const approved = (await js<{ approved: boolean }>(
        "window.api.approvePlan('.omcp/plans/p54.md')",
      )) as { approved: boolean };
      const writeAfterApprove = policyService?.decide("write", { path: "results/tables/ok.csv", content: "1" });
      await js("window.api.setPlanMode(false)");

      // ---------- 还原 ----------
      appSettings.trustProject = beforeTrust;
      defaultRuntime.setTrustProject(beforeTrust);
      saveAppSettings();
      if (restoredSession) {
        currentSessionFile = restoredSession;
        defaultRuntime.setSessionFile(restoredSession);
      }
      defaultRuntime.stop();
      await sleep(400);
      defaultRuntime.start();

      console.log(
        "P3_SELFTEST_P54 " +
          JSON.stringify({
            e2e: {
              csv: existsSync(e2eCsv),
              skillInSession: sessionText.includes("desc-stats"),
              routeSaved: savedRoute.ok,
              routeExported: Boolean(exported.path),
              exportHasAll,
            },
            vision: { brokerTextOnly: visionOk },
            plan: {
              reasonSent,
              deniedWrite: deniedWrite?.action,
              deniedBash: deniedBash?.action,
              reasonSeen,
              approved: approved.approved,
              writeAfterApprove: writeAfterApprove?.action,
            },
            restored: supervisor.getTrustProject() === beforeTrust,
          }),
      );
    }

    if (SELFTEST_MODE === "p53") {
      // 1) 路线：写 3 步 → 读回 → 导出
      const doc = {
        version: 1,
        updatedAt: new Date().toISOString(),
        steps: [
          { id: "s1", title: "读数据并检查缺失", purpose: "确认行列与缺失", inputs: "data/raw/demo.csv", outputs: "—", status: "done", evidence: "strong" },
          { id: "s2", title: "按组描述统计", purpose: "得到 mean/median/count", inputs: "data/raw/demo.csv", outputs: "results/tables/a1-stats.csv", status: "done", evidence: "limited" },
          { id: "s3", title: "画箱线图", purpose: "比较组间分布", inputs: "results/tables/a1-stats.csv", outputs: "figures/a1-boxplot.png", status: "todo", evidence: "none" },
        ],
      };
      const saved = (await js<{ ok: boolean; errors: string[] }>(
        "window.api.saveRoute(" + JSON.stringify(doc) + ")",
      )) as { ok: boolean; errors: string[] };
      const loaded = (await js<{ doc: { steps: Array<{ title: string }> }; exists: boolean }>(
        "window.api.loadRoute()",
      )) as { doc: { steps: Array<{ title: string }> }; exists: boolean };
      const exported = (await js<{ path: string | null; error?: string }>(
        "window.api.exportRoute()",
      )) as { path: string | null; error?: string };
      let exportHasSteps = false;
      if (exported.path) {
        const text = readFileSync(exported.path, "utf8");
        exportHasSteps = doc.steps.every((s) => text.includes(s.title));
      }

      // 1b) 路线面板渲染
      await js('[...document.querySelectorAll(".viewtabs button")].find(function(b){return b.textContent.trim()==="路线";}).click()');
      await sleep(1200);
      const uiSteps = await js<number>('document.querySelectorAll(".route-step").length');

      // 2) 方案期门
      await js("window.api.setPlanMode(true)");
      const blockedWrite = policyService?.decide("write", { path: "results/tables/x.csv", content: "x" });
      const allowedRead = policyService?.decide("read", { path: "AGENTS.md" });
      const blockedBash = policyService?.decide("bash", { command: "ls" });

      // 3) 批准：非法路径应失败，合法方案文件应解锁
      const badApprove = (await js<{ approved: boolean }>(
        "window.api.approvePlan('README.md')",
      )) as { approved: boolean };
      const planFile = join(workspaceRoot, ".omcp", "plans", "p53.md");
      mkdirSync(join(workspaceRoot, ".omcp", "plans"), { recursive: true });
      writeFileSync(planFile, "# 方案\n\n1. 读数据\n2. 统计\n", "utf8");
      const goodApprove = (await js<{ approved: boolean; planPath: string | null }>(
        "window.api.approvePlan('.omcp/plans/p53.md')",
      )) as { approved: boolean; planPath: string | null };
      const writeAfterApprove = policyService?.decide("write", {
        path: "results/tables/x.csv",
        content: "x",
      });

      // 3b) 内容绑定（P1-01）：批准后改动方案文件应即时失效
      writeFileSync(planFile, "# 方案\n\n1. 读数据\n2. 统计（改过了）\n", "utf8");
      const writeAfterDrift = policyService?.decide("write", {
        path: "results/tables/x.csv",
        content: "x",
      });
      const planGateAfterDrift = planStatus();

      // 4) 关闭方案期
      await js("window.api.setPlanMode(false)");
      const writeAfterDisable = policyService?.decide("write", {
        path: "results/tables/x.csv",
        content: "x",
      });

      console.log(
        "P3_SELFTEST_P53 " +
          JSON.stringify({
            route: {
              saved: saved.ok,
              loadedSteps: loaded.doc.steps.length,
              exists: loaded.exists,
              exported: Boolean(exported.path),
              exportHasSteps,
              uiSteps,
            },
            plan: {
              blockedWrite: blockedWrite?.action,
              blockedRule: blockedWrite?.ruleId,
              allowedRead: allowedRead?.action,
              blockedBash: blockedBash?.action,
              badApprove: badApprove.approved,
              goodApprove: goodApprove.approved,
              approvedPath: goodApprove.planPath,
              writeAfterApprove: writeAfterApprove?.action,
              writeAfterDrift: writeAfterDrift?.action,
              driftRule: writeAfterDrift?.ruleId,
              revokedAfterDrift: planGateAfterDrift.approved === false,
              writeAfterDisable: writeAfterDisable?.action,
            },
          }),
      );
    }

    if (SELFTEST_MODE === "p52") {
      const { createServer } = await import("node:http");
      const tiny =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

      // 本地 mock 视觉端点：只验证链路，不打真实网络
      const mock = createServer((req, res) => {
        if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: "MOCK-VISION 标题：Demo Boxplot；横轴：group；纵轴：value；趋势：HS 最低。",
                  },
                },
              ],
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
      const address = mock.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const before = {
        baseUrl: appSettings.visionBaseUrl,
        model: appSettings.visionModel,
      };
      appSettings.visionBaseUrl = `http://127.0.0.1:${port}`;
      appSettings.visionModel = "mock-vision";
      secretStore?.set("vision:apiKey", "test-key");

      const describe = await describeImage(
        {
          baseUrl: appSettings.visionBaseUrl,
          model: appSettings.visionModel,
          apiKey: "test-key",
        },
        tiny,
        "image/png",
      );
      const transcribed = await transcribeImages([
        { type: "image", data: tiny, mimeType: "image/png" },
      ]);
      const savedPath = saveAttachment(tiny, "image/png");
      const supports = await modelSupportsImage();
      const view = visionView();
      // 模拟“纯文本模型”：broker 的图片描述回调应返回文字而不是 null
      forceTextOnlyForTest = true;
      const brokerDescription = await describeForVision(tiny, "image/png");
      forceTextOnlyForTest = false;

      // 还原
      appSettings.visionBaseUrl = before.baseUrl;
      appSettings.visionModel = before.model;
      secretStore?.clear("vision:apiKey");
      saveAppSettings();
      await new Promise<void>((resolve) => mock.close(() => resolve()));

      console.log(
        "P3_SELFTEST_P52 " +
          JSON.stringify({
            describeOk: describe.ok,
            describeHasMarker: Boolean(describe.text && describe.text.includes("MOCK-VISION")),
            describeError: describe.error ?? null,
            transcribedHasMarker: transcribed.includes("MOCK-VISION"),
            transcribedHasHeader: transcribed.startsWith("[图片转述]"),
            attachmentSaved: Boolean(savedPath && existsSync(savedPath)),
            modelSupportsImage: supports,
            brokerTextOnlyPath: Boolean(
              brokerDescription.text && brokerDescription.text.includes("MOCK-VISION"),
            ),
            view: { hasKey: view.hasKey, supported: view.supported, model: view.model },
            restored: appSettings.visionBaseUrl === before.baseUrl,
          }),
      );
    }

    if (SELFTEST_MODE === "p51") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 240; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };

      // 1) 准备一个技能（幂等）
      const skillDir = join(workspaceRoot, ".agents", "skills", "desc-stats");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        "---\nname: desc-stats\ndescription: 按分组做描述统计并输出 CSV。用户说“描述统计”“分组汇总”时使用。\n---\n\n# 描述统计\n\n1. 读取指定数据文件。\n2. 按分组列计算 mean / median / count。\n3. 打印表格。\n4. 写入 results/tables/desc-stats.csv。\n",
        "utf8",
      );

      // 2) 信任本项目（否则 pi 不加载 .agents/skills），并用新会话验证索引
      const restoredSession = currentSessionFile;
      currentSessionFile = null;
      defaultRuntime.setSessionFile(null);
      const beforeTrust = appSettings.trustProject;
      appSettings.trustProject = true;
      defaultRuntime.setTrustProject(true);
      defaultRuntime.stop();
      await sleep(600);
      defaultRuntime.start();
      await sleep(2500);

      // 3) 启停（只重命名 SKILL.md）
      const disabled = setSkillEnabled(workspaceRoot, "desc-stats", false);
      await sleep(400);
      const listOff = scanSkills(workspaceRoot).find((x) => x.name === "desc-stats")?.enabled ?? null;
      const enabled = setSkillEnabled(workspaceRoot, "desc-stats", true);
      await sleep(400);
      const listOn = scanSkills(workspaceRoot).find((x) => x.name === "desc-stats")?.enabled ?? null;

      // 4) 让模型用技能跑一次
      const auditStart = (auditLog?.read(200) ?? []).length;
      // 清掉上一轮产物，避免把旧文件当成本轮证据
      try {
        (await import("node:fs")).unlinkSync(join(workspaceRoot, "results", "tables", "desc-stats.csv"));
      } catch {
        // 不存在就算了
      }

      // 等 pi 就绪，再发提示（重启后 2.5s 不一定够）
      let ready = false;
      for (let i = 0; i < 40; i++) {
        try {
          const st = await js<SessionState>("window.api.getState()");
          if (st) {
            ready = true;
            break;
          }
        } catch {
          // 继续等
        }
        await sleep(500);
      }

      const startedAt = new Date().toISOString();
      let sent = false;
      for (let i = 0; i < 10 && !sent; i++) {
        sent = await js<boolean>(
          'window.api.prompt("请使用 desc-stats 技能：用 bash 执行 python 读取 data/raw/demo.csv，按 group 计算 mean/median/count，写到 results/tables/desc-stats.csv，完成后只回复 done。不要使用 run_code。")',
        );
        if (!sent) await sleep(1000);
      }
      // 等到 CSV 出现或 180 秒超时（模型可能分多轮）
      for (let i = 0; i < 180; i++) {
        await sleep(1000);
        if (existsSync(join(workspaceRoot, "results", "tables", "desc-stats.csv"))) break;
      }
      await sleep(1500);

      const csvPath = join(workspaceRoot, "results", "tables", "desc-stats.csv");
      const csv = existsSync(csvPath);

      // 5) 技能索引是否进了会话上下文
      let skillInIndex = false;
      let newest: string | null = null;
      let newestMtime = 0;
      try {
        for (const name of readdirSync(sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(sessionDir, name);
          const mtime = statSync(file).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newest = file;
          }
        }
      } catch {
        newest = null;
      }
      let modelReadSkill = false;
      if (newest) {
        const body = readFileSync(newest, "utf8");
        skillInIndex = body.includes("desc-stats") && body.includes(".agents");
        modelReadSkill = body.includes("SKILL.md");
      }

      const auditAfter = auditLog?.read(200) ?? [];
      const fresh = auditAfter.length > auditStart ? auditAfter.slice(0, auditAfter.length - auditStart) : [];
      const skillAudit = auditAfter.some(
        (e) => e.ts >= startedAt && /skill:desc-stats/.test(e.summary),
      );

      // 6) 还原信任状态与会话
      if (restoredSession) {
        currentSessionFile = restoredSession;
        defaultRuntime.setSessionFile(restoredSession);
      }
      appSettings.trustProject = beforeTrust;
      defaultRuntime.setTrustProject(beforeTrust);
      saveAppSettings();
      defaultRuntime.stop();
      await sleep(400);
      defaultRuntime.start();

      console.log(
        "P3_SELFTEST_P51 " +
          JSON.stringify({
            skillDir: existsSync(join(skillDir, "SKILL.md")),
            ready,
            sent,
            toggle: { disabled, listOff, enabled, listOn },
            csv,
            skillInIndex,
            skillAudit,
            modelReadSkill,
            auditCount: fresh.length,
            trustRestored: supervisor.getTrustProject() === beforeTrust,
          }),
      );
    }

    if (SELFTEST_MODE === "p50") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 120; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };

      // 用新会话验证：恢复旧会话时 header 里的 cwd 是历史的，不能作为本次进程的证据
      const restoredSession = currentSessionFile;
      currentSessionFile = null;
      defaultRuntime.setSessionFile(null);
      defaultRuntime.stop();
      await sleep(600);
      defaultRuntime.start();
      await sleep(2500);

      await js('window.api.prompt("只回复：p50-ok")');
      await waitIdle();
      await sleep(800);

      // 取最新会话文件，读 header 里的 cwd（pi 自己写的，最可信）
      let newest: string | null = null;
      let newestMtime = 0;
      try {
        for (const name of readdirSync(sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          const file = join(sessionDir, name);
          const mtime = statSync(file).mtimeMs;
          if (mtime > newestMtime) {
            newestMtime = mtime;
            newest = file;
          }
        }
      } catch {
        newest = null;
      }

      let sessionCwd: string | null = null;
      let agentsLoaded = false;
      let workspaceInPrompt = false;
      if (newest) {
        const lines = readFileSync(newest, "utf8").split(/\r?\n/).filter(Boolean);
        try {
          const header = JSON.parse(lines[0]) as { cwd?: string };
          sessionCwd = header.cwd ?? null;
        } catch {
          sessionCwd = null;
        }
        const markerSource = join(workspaceRoot, "AGENTS.md");
        let marker = "";
        try {
          marker = readFileSync(markerSource, "utf8").split(/\r?\n/).find((l) => l.trim().startsWith("#")) ?? "";
        } catch {
          marker = "";
        }
        const body = lines.join("\n");
        agentsLoaded = marker ? body.includes(marker.trim()) : false;
        workspaceInPrompt = body.includes(workspaceRoot.replace(/\\/g, "/")) || body.includes(workspaceRoot);
      }

      const normalize = (p: string | null) => (p ? p.replace(/\\/g, "/").toLowerCase() : "");
      // 信任开关：切换后应落到 appSettings 并触发 pi 重启
      await js('window.api.updateSettingsDetail({ trustProject: true })');
      await sleep(1200);
      const trustOn = supervisor.getTrustProject();
      const trustSetting = (await js<AppSettingsDetail>("window.api.getSettingsDetail()")).trustProject;
      await js('window.api.updateSettingsDetail({ trustProject: false })');
      await sleep(1200);
      const trustOff = supervisor.getTrustProject();

      // 恢复原会话，避免测试改变用户的当前会话
      if (restoredSession) {
        currentSessionFile = restoredSession;
        defaultRuntime.setSessionFile(restoredSession);
        defaultRuntime.stop();
        await sleep(400);
        defaultRuntime.start();
      }

      console.log(
        "P3_SELFTEST_P50 " +
          JSON.stringify({
            supervisorCwd: supervisor.getCwd(),
            workspaceRoot: normalize(workspaceRoot),
            sessionCwd: normalize(sessionCwd),
            cwdCorrect: normalize(sessionCwd) === normalize(workspaceRoot),
            agentsLoaded,
            workspaceInPrompt,
            trustProject: supervisor.getTrustProject(),
            trustToggle: { on: trustOn, setting: trustSetting, off: trustOff },
            sessionFile: newest ? newest.split(/[\\/]/).pop() : null,
          }),
      );
    }

    if (SELFTEST_MODE === "p40") {
      // 1) 脚本内删除：命令文本干净，删除在文件里
      const scriptDir = join(workspaceRoot, "scripts");
      mkdirSync(scriptDir, { recursive: true });
      const scriptFile = join(scriptDir, "p40-clean.sh");
      writeFileSync(scriptFile, "#!/bin/sh\nrm -rf ./data\n", "utf8");
      const danger = policyService?.decide("bash", { command: "bash scripts/p40-clean.sh" });
      const benignFile = join(scriptDir, "p40-ok.sh");
      writeFileSync(benignFile, "#!/bin/sh\necho hello\n", "utf8");
      const benign = policyService?.decide("bash", { command: "bash scripts/p40-ok.sh" });
      const plain = policyService?.decide("bash", { command: "echo hi > data/note.txt" });

      // 2) 权限页：审计表格与筛选/分页控件（按文字选中）
      await js('[...document.querySelectorAll(".viewtabs button")].find(function(b){return b.textContent.trim()==="权限";}).click()');
      await sleep(1200);
      const rows = await js<number>('document.querySelectorAll(".perm-card .perm-table tbody tr").length');
      const pager = await js<boolean>('!!document.querySelector(".perm-pager")');
      const ttl = await js<boolean>('!!document.querySelector(".perm-settings select")');
      const filters = await js<number>('document.querySelectorAll(".perm-filters input, .perm-filters select").length');

      try {
        (await import("node:fs")).unlinkSync(scriptFile);
        (await import("node:fs")).unlinkSync(benignFile);
      } catch {
        // ignore
      }

      console.log(
        "P3_SELFTEST_P40 " +
          JSON.stringify({
            scriptDanger: danger?.action ?? null,
            scriptRule: danger?.ruleId ?? null,
            benignScript: benign?.action ?? null,
            plainWrite: plain?.action ?? null,
            permRows: rows,
            pager,
            ttlSelect: ttl,
            filters,
          }),
      );
    }

    if (SELFTEST_MODE === "abort") {
      const waitModal = async (ms: number): Promise<boolean> => {
        for (let i = 0; i < Math.ceil(ms / 500); i++) {
          if (await js<boolean>('!!document.querySelector(".approval-options button")')) return true;
          await sleep(500);
        }
        return false;
      };
      await js(
        "window.api.prompt(" +
          JSON.stringify("请执行这一条命令：pip install --help 。只执行一次 bash。") +
          ")",
      );
      const opened = await waitModal(60_000);
      const pendingBefore = pendingApprovals.size;
      defaultRuntime.stop();
      await sleep(1500);
      const modalGone = !(await js<boolean>('!!document.querySelector(".approval-options button")'));
      const pendingAfter = pendingApprovals.size;
      const auditAbort = (auditLog?.read(50) ?? []).some((e) => e.scope === "abort");
      defaultRuntime.start();
      await sleep(1500);
      console.log(
        "P3_SELFTEST_ABORT " +
          JSON.stringify({ opened, pendingBefore, modalGone, pendingAfter, auditAbort }),
      );
    }

    if (SELFTEST_MODE === "readonly-notebook") {
      const policyFile = join(workspaceRoot, ".omcp", "policy.json");
      const original = existsSync(policyFile) ? readFileSync(policyFile, "utf8") : null;
      const before = appSettings.readonlyNotebook;
      writeFileSync(policyFile, JSON.stringify({ version: 1, mode: "readonly" }, null, 2) + "\n", "utf8");
      policyService?.reload();
      await sleep(1500);

      await js("window.api.setAppSettings({ readonlyNotebook: false })");
      const blocked = await js<boolean>('window.api.runCell("ro1", "x = 1")');

      await js("window.api.setAppSettings({ readonlyNotebook: true })");
      const allowed = await js<boolean>('window.api.runCell("ro2", "y = 2")');

      await js("window.api.setAppSettings({ readonlyNotebook: false })");
      appSettings.readonlyNotebook = before;
      saveAppSettings();
      if (original === null) {
        try {
          (await import("node:fs")).unlinkSync(policyFile);
        } catch {
          // ignore
        }
      } else {
        writeFileSync(policyFile, original, "utf8");
      }
      policyService?.reload();
      console.log(
        "P3_SELFTEST_READONLY_NOTEBOOK " + JSON.stringify({ blocked: blocked === false, allowed, mode: "readonly" }),
      );
    }

    if (SELFTEST_MODE === "timeout") {
      const waitModal = async (ms: number): Promise<boolean> => {
        for (let i = 0; i < Math.ceil(ms / 500); i++) {
          if (await js<boolean>('!!document.querySelector(".approval-options button")')) return true;
          await sleep(500);
        }
        return false;
      };
      await js(
        "window.api.prompt(" +
          JSON.stringify("请执行这一条命令：pip install --help 。只执行一次 bash。") +
          ")",
      );
      const opened = await waitModal(60_000);
      const started = Date.now();
      let closed = false;
      for (let i = 0; i < 300; i++) {
        await sleep(500);
        const still = await js<boolean>('!!document.querySelector(".approval-options button")');
        if (opened && !still) {
          closed = true;
          break;
        }
        if (!opened && Date.now() - started > 60_000) break;
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      const audit = auditLog?.read(50) ?? [];
      const timeoutEntry = audit.find((e) => e.decision === "timeout");
      console.log(
        "P3_SELFTEST_TIMEOUT " +
          JSON.stringify({
            opened,
            autoClosed: closed,
            seconds,
            auditTimeout: !!timeoutEntry,
            scope: timeoutEntry?.scope ?? null,
          }),
      );
    }

    if (SELFTEST_MODE === "readonly") {
      const policyFile = join(workspaceRoot, ".omcp", "policy.json");
      const original = existsSync(policyFile) ? readFileSync(policyFile, "utf8") : null;
      writeFileSync(
        policyFile,
        JSON.stringify({ version: 1, mode: "readonly" }, null, 2) + "\n",
        "utf8",
      );
      policyService?.reload();
      await sleep(2500);
      const info = policyService?.info() ?? null;
      const runCode = policyService?.decide("run_code", { code: "print(1)" });
      const readDecision = policyService?.decide("read", { path: "AGENTS.md" });
      const banner = await js<boolean>(
        '!!document.querySelector(".banner.readonly")',
      );
      if (original === null) {
        try {
          // 只删这一个文件；策略是本测试自己写的
          (await import("node:fs")).unlinkSync(policyFile);
        } catch {
          // ignore
        }
      } else {
        writeFileSync(policyFile, original, "utf8");
      }
      policyService?.reload();
      console.log(
        "P3_SELFTEST_READONLY " +
          JSON.stringify({
            mode: info?.mode ?? null,
            source: info?.source ?? null,
            runCode: runCode?.action ?? null,
            read: readDecision?.action ?? null,
            banner,
          }),
      );
    }

    if (SELFTEST_MODE === "grant") {
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 120; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };
      const waitModal = async (ms: number): Promise<boolean> => {
        for (let i = 0; i < Math.ceil(ms / 500); i++) {
          if (await js<boolean>('!!document.querySelector(".approval-options button")')) return true;
          await sleep(500);
        }
        return false;
      };
      const click = (label: string) =>
        js(
          '[...document.querySelectorAll(".approval-options button")]' +
            '.find((b) => b.textContent === ' +
            JSON.stringify(label) +
            ')?.click()',
        );
      const ask = (extra: string) =>
        js(
          "window.api.prompt(" +
            JSON.stringify("请执行这一条命令：" + extra + " 。只执行一次 bash。") +
            ")",
        );

      const before = (auditLog?.read(50) ?? []).length;

      await ask("pip install --help");
      const modal1 = await waitModal(60_000);
      if (modal1) await click("总是允许");
      await waitIdle();

      await ask("pip install --version");
      const modal2 = await waitModal(25_000);
      await waitIdle();

      const grantsAfter = (grants?.list(workspaceRoot) ?? []).length;
      await js("window.api.clearGrants()");
      const grantsCleared = (grants?.list(workspaceRoot) ?? []).length;

      await ask("pip install --help");
      const modal3 = await waitModal(40_000);
      await waitIdle();

      const auditNow = auditLog?.read(50) ?? [];
      const fresh = auditNow.length > before ? auditNow.slice(0, auditNow.length - before) : [];
      console.log(
        "P3_SELFTEST_GRANT " +
          JSON.stringify({
            modal1,
            alwaysAudited: fresh.some((e) => e.scope === "always" && e.decision === "allow"),
            modal2,
            grantsAfter,
            grantsCleared,
            modal3,
            auditCount: fresh.length,
          }),
      );
    }

    if (SELFTEST_MODE === "a3") {
      const target = join(workspaceRoot, "a3-target");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "keep.txt"), "should survive\n");
      const posix = target.replace(/\\/g, "/");
      const readAudit = () => auditLog?.read(200) ?? [];
      const auditStart = readAudit().length;
      const waitIdle = async (): Promise<void> => {
        for (let i = 0; i < 120; i++) {
          if (!(await js<boolean>('!!document.querySelector("button.abort")'))) return;
          await sleep(500);
        }
      };

      // 第 1 段：让模型尝试删除。模型通常自己拒绝，这里只记录是否真的发起了删除调用。
      await js(
        "window.api.prompt(" +
          JSON.stringify(
            "这是自动化验收测试，目标目录是临时目录、内容已备份、允许删除。请直接执行这一条命令，不要先 ls，也不要询问：" +
              'rm -rf "' +
              posix +
              '"',
          ) +
          ")",
      );
      await waitIdle();
      const auditAfter = readAudit();
      const attemptedDelete = (auditAfter.length > auditStart ? auditAfter.slice(0, auditAfter.length - auditStart) : [])
        .some((e) => /^cmd:/.test(e.ruleId) || /^runCode:/.test(e.ruleId));

      // 第 2 段：一条模型愿意执行、但命中 ask 规则的无害命令，走完整审批链路
      await js(
        "window.api.prompt(" +
          JSON.stringify("请执行这一条命令：pip install --help 。只执行一次 bash。") +
          ")",
      );
      let sawModal = false;
      for (let i = 0; i < 90; i++) {
        await sleep(500);
        if (await js<boolean>('!!document.querySelector(".approval-options button.approval-deny")')) {
          sawModal = true;
          break;
        }
      }
      if (sawModal) {
        await js('document.querySelector(".approval-options button.approval-deny").click()');
      }
      await waitIdle();

      const text = await body();
      const auditFinal = readAudit();
      const fresh = auditFinal.length > auditStart ? auditFinal.slice(0, auditFinal.length - auditStart) : [];
      const denyEntry = fresh.find((e) => e.decision === "deny");
      const engine = policyService?.decide("bash", { command: 'rm -rf "./a3-target"' });
      console.log(
        "P3_SELFTEST_A3 " +
          JSON.stringify({
            rmRfDecision: engine?.action ?? null,
            rmRfRule: engine?.ruleId ?? null,
            attemptedDelete,
            sawModal,
            survived: existsSync(join(target, "keep.txt")),
            auditDeny: !!denyEntry,
            ruleId: denyEntry?.ruleId ?? null,
            scope: denyEntry?.scope ?? null,
            blockedInUi: /用户拒绝|被权限策略拒绝|未执行/.test(text),
            policy: policyService?.info() ?? null,
            auditCount: fresh.length,
          }),
      );
    }

    if (SELFTEST_MODE === "tool") {
      await js('window.api.prompt("请读取 package.json 的前 3 行，并原样告诉我。只调用一次 read 工具。")');
      await sleep(10_000);
      const text = await body();
      console.log(
        "P1_SELFTEST_TOOL " +
          JSON.stringify({ hasRead: /read/i.test(text), hasPackage: /package\.json/i.test(text) }),
      );
    }

    if (SELFTEST_MODE === "stop") {
      await js('window.api.prompt("请写一篇 800 字的散文，主题是盐沼的清晨。")');
      await sleep(1200);
      const t0 = Date.now();
      await js("window.api.abort()");
      await sleep(4500);
      const text = await body();
      console.log(
        "P1_SELFTEST_STOP " +
          JSON.stringify({
            elapsedMs: Date.now() - t0,
            ready: /READY/.test(text),
            hasStopButton: /停止/.test(text),
          }),
      );
    }

    if (SELFTEST_MODE === "a1") {
      const a1Code = [
        "import pandas as pd",
        "import matplotlib.pyplot as plt",
        'df = pd.read_csv("data/raw/demo.csv")',
        'stats = df.groupby("group")["value"].agg(["mean","median","count"])',
        "print(stats)",
        'df.boxplot(column="value", by="group")',
        'plt.suptitle("")',
        'plt.savefig("figures/a1-boxplot.png", dpi=150)',
        "plt.show()",
        'stats.to_csv("results/tables/a1-stats.csv")',
      ].join("\n");
      const run = await js<boolean>(`window.api.runCell("a1", ${JSON.stringify(a1Code)})`);
      await sleep(1500);
      const figure = existsSync(join(workspaceRoot, "figures", "a1-boxplot.png"));
      const table = existsSync(join(workspaceRoot, "results", "tables", "a1-stats.csv"));
      console.log(
        "P1_SELFTEST_A1 " + JSON.stringify({ run, figure, table }),
      );
    }

    if (SELFTEST_MODE === "stability") {
      let failures = 0;
      for (let i = 0; i < 50; i++) {
        const ok = await js<boolean>(
          `window.api.runCell("s${i}", "print(${i})")`,
        );
        if (!ok) failures++;
      }
      const longRun = js<boolean>(
        'window.api.runCell("int", "while True: pass")',
      );
      await sleep(800);
      await js("window.api.interruptKernel('python')");
      await longRun.catch(() => false);
      const restarted = await js<boolean>("window.api.restartKernel('python')");
      console.log(
        "P1_SELFTEST_STABILITY " +
          JSON.stringify({ runs: 50, failures, restarted }),
      );
    }

    if (SELFTEST_MODE === "rnotebook") {
      const dbgPath = join(app.getPath("userData"), "rnb-debug.log");
      writeFileSync(dbgPath, "start\n", "utf8");
      const dbg = (m: string) =>
        appendFileSync(dbgPath, new Date().toISOString() + " " + m + "\n", "utf8");
      const code = "x <- 41\nprint(x + 1)\nplot(1:10)";
      writeFileSync(
        notebookPath(),
        JSON.stringify({ cells: [{ id: "nb-r", language: "r", code }] }, null, 2) + "\n",
        "utf8",
      );
      await js(
        "[...document.querySelectorAll('.viewtabs button')].find((b) => b.textContent === '笔记本')?.click()",
      );
      dbg("file written");
      await sleep(900);
      dbg("clicked");
      const run = await js<boolean>(
        `window.api.runCell("nb-r", ${JSON.stringify(code)}, "r")`,
      );
      dbg("run returned " + String(run));
      await sleep(12_000);
      dbg("after sleep");
      const text = await body();
      dbg("text " + text.length);
      const images = await js<number>("document.querySelectorAll('.nb-output img').length");
      dbg("images " + images);
      const vars = await js<string[]>('window.api.getVariables("r")');
      dbg("vars " + vars.length);
      console.log(
        "P1_SELFTEST_RNOTEBOOK " +
          JSON.stringify({ run, has42: /42/.test(text), images, vars: vars.length, hasX: vars.includes("x") }),
      );
    }

    if (SELFTEST_MODE === "notebook") {
      const code = "import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.show()";
      writeFileSync(
        notebookPath(),
        JSON.stringify({ cells: [{ id: "nb-test", language: "python", code }] }, null, 2) + "\n",
        "utf8",
      );
      // 笔记本在启动时就把 cells 读进内存了；写完文件必须重载渲染进程，否则跑的 id 对不上
      win!.webContents.reload();
      await sleep(2500);
      // 笔记本现在是右坞的页签（不是顶部 viewtabs）：先展开坞、再点“笔记本”
      const clicked = await js<boolean>(
        `(() => {
          const dock = document.querySelector('.dock');
          if (dock && dock.classList.contains('dock-collapsed')) {
            document.querySelector('.dock-toggle')?.click();
          }
          const btn = [...document.querySelectorAll('.dock-tabs button')].find((b) => b.textContent.trim() === '笔记本');
          btn?.click();
          return !!btn;
        })()`,
      );
      await sleep(900);
      const run = await js<boolean>(
        `window.api.runCell("nb-test", ${JSON.stringify(code)})`,
      );
      await sleep(10_000);
      const cellCount = await js<number>("document.querySelectorAll('.nb-cell').length");
      const images = await js<number>("document.querySelectorAll('.nb-output img').length");
      const vars = await js<string[]>("window.api.getVariables()");
      mkdirSync(screenshotsDir, { recursive: true });
      const shot = await win!.webContents.capturePage();
      const shotPath = join(screenshotsDir, "p2-notebook.png");
      writeFileSync(shotPath, shot.toPNG());
      console.log("P1_SELFTEST_NOTEBOOK_IMG " + shotPath);
      console.log(
        "P1_SELFTEST_NOTEBOOK " +
          JSON.stringify({ run, clicked, hasCell: cellCount > 0, images, vars: vars.length }),
      );
    }

    if (SELFTEST_MODE === "kernel") {
      await js('window.api.prompt("请使用 run_code 工具执行：x = 41; print(x)")');
      await sleep(12000);
      await js('window.api.prompt("请再用 run_code 执行：print(x + 1)")');
      await sleep(12000);
      const text = await body();
      console.log(
        "P1_SELFTEST_KERNEL " +
          JSON.stringify({ has41: /41/.test(text), has42: /42/.test(text) }),
      );
    }

    if (SELFTEST_MODE === "workspace") {
      const target = "D:\\desktop\\coding\\oh-my-coding-pi\\sandbox";
      // 自检不能改掉用户的「上次打开」
      const before = readWorkspaces();
      const res = await js(`window.api.openWorkspace(${JSON.stringify(target)})`);
      await sleep(1500);
      const info = await js("window.api.getWorkspace()");
      const sessions = await js<unknown[]>("window.api.getSessions()");
      console.log(
        "P1_SELFTEST_WORKSPACE " +
          JSON.stringify({ res, info, sessions: sessions.length }),
      );
      if (before.lastWorkspace) activateWorkspaceView(before.lastWorkspace);
      writeWorkspaces({ lastWorkspace: before.lastWorkspace, recent: before.recent ?? [] });
    }

    if (SELFTEST_MODE === "multiws") {
      // 修改 5 · C5：跨工作区会话列表的端到端验证（不启 pi，只验定位与列表）
      const root = join(app.getPath("temp"), "omcp-selftest-ws");
      // 自检不能改掉用户的「上次打开」
      const before = readWorkspaces();
      mkdirSync(root, { recursive: true });
      const opened = await js(`window.api.openWorkspace(${JSON.stringify(root)})`);
      await sleep(300);
      const dir = join(root, ".omcp", "sessions");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "2026-11-25T00-00-00-000Z_selftest.jsonl");
      if (!existsSync(file)) {
        writeFileSync(
          file,
          JSON.stringify({ id: "selftest-0001", timestamp: new Date().toISOString() }) + "\n",
          "utf8",
        );
      }
      const listed = await js<{ sessions?: unknown[]; titles?: Record<string, string> }>(
        `window.api.listSessionsIn(${JSON.stringify(root)})`,
      );
      let rejected = false;
      try {
        await js(`window.api.listSessionsIn(${JSON.stringify("C:\\Windows")})`);
      } catch {
        rejected = true;
      }
      const current = await js<{ file?: string | null; workspace?: string }>(
        "window.api.getCurrentSession()",
      );
      console.log(
        "P1_SELFTEST_MULTIWS " +
          JSON.stringify({
            opened: Boolean(opened),
            count: listed?.sessions?.length ?? 0,
            titles: Object.keys(listed?.titles ?? {}).length,
            rejected,
            workspace: current?.workspace === root,
          }),
      );
      if (before.lastWorkspace) activateWorkspaceView(before.lastWorkspace);
      writeWorkspaces({ lastWorkspace: before.lastWorkspace, recent: before.recent ?? [] });
    }

    if (SELFTEST_MODE === "m5") {
      /**
       * 修改 5 的端到端验证（不需要模型）：
       *  ① 同一工作区连开两段会话 → 两个槽；
       *  ② 切到另一个（空）工作区 → ②里的槽**不被杀**；
       *  ③ 在新工作区新建会话 → 走 slotPool，新文件落在新工作区。
       * 跑完还原用户的 workspaces.json。
       */
      const t: Record<string, unknown> = {};
      const before = readWorkspaces();
      for (let i = 0; i < 200; i++) {
        if (await js<boolean>("window.api.isPiReady()")) {
          t.ready = true;
          break;
        }
        await sleep(250);
      }
      const sessions = await js<{ sessionFile: string }[]>("window.api.getSessions()");
      t.sessions = sessions.length;
      if (sessions.length >= 2) {
        const t0 = Date.now();
        const first = await js(`window.api.openSession(${JSON.stringify(sessions[0].sessionFile)})`);
        t.openFirstMs = Date.now() - t0;
        const t1 = Date.now();
        const second = await js(`window.api.openSession(${JSON.stringify(sessions[1].sessionFile)})`);
        t.openSecondMs = Date.now() - t1;
        const board1 = await js<{
          slots: { id: string; running: boolean; sessionFile: string | null }[];
          sessions: { file: string; running: boolean; slotId: string | null }[];
        }>("window.api.getSessionBoard()");
        const runningAfterOpen = board1.slots.filter((s) => s.running).length;
        t.slotsAfterOpen = runningAfterOpen;
        // 挑一段绑在**非默认槽**上的会话：默认槽是"视图独占"的，切走时会被换去新工作区，
        // 拿它断言"没被杀"没有意义；要证明的是别的槽不受影响。
        const nonDefault = board1.sessions.find(
          (item) => item.slotId && item.slotId !== "default" && item.running,
        );

        const wsB = join(app.getPath("temp"), "omcp-m5-ws");
        mkdirSync(wsB, { recursive: true });
        const t2 = Date.now();
        await js(`window.api.openWorkspace(${JSON.stringify(wsB)})`);
        t.switchMs = Date.now() - t2;
        const board2 = await js<{
          slots: { id: string; running: boolean; sessionFile: string | null }[];
          sessions: { file: string; running: boolean; busy: boolean; state: string }[];
        }>("window.api.getSessionBoard()");
        const kept = nonDefault
          ? board2.sessions.find((item) => sessionKey(item.file) === sessionKey(nonDefault.file))
          : undefined;
        t.oldSlotStillRunning = Boolean(kept?.running);
        t.keptFile = kept ? basename(kept.file) : (nonDefault ? null : "没有非默认槽可验");
        t.slotsAfterSwitch = board2.slots.filter((s) => s.running).length;


        const t3 = Date.now();
        const created = await js<boolean>(
          `window.api.newSession(undefined, ${JSON.stringify(wsB)})`,
        );
        t.newSessionMs = Date.now() - t3;
        const cur = await js<{ file?: string | null; workspace?: string }>(
          "window.api.getCurrentSession()",
        );
        t.newSessionOk = Boolean(created);
        t.newSessionInB = Boolean(
          cur?.file && sessionKey(cur.file).startsWith(sessionKey(sessionsDirOf(wsB))),
        );
        // 修改六 · S2：界面读到的档必须等于实际执行用的档
        const perm = await js<{ effective?: string }>("window.api.getPermission()");
        const pol = await js<{ mode?: string }>("window.api.getPolicy()");
        t.permissionInSync = Boolean(perm?.effective && perm.effective === pol?.mode);
        t.ok = Boolean(
          first &&
            second &&
            runningAfterOpen >= 2 &&
            kept?.running &&
            t.newSessionOk &&
            t.newSessionInB,
        );
        console.log(
          "P1_SELFTEST_M5 " +
            JSON.stringify({ ...t, first: Boolean(first), second: Boolean(second) }),
        );
      } else {
        console.log("P1_SELFTEST_M5 " + JSON.stringify({ ...t, skip: "需要至少 2 段会话" }));
      }
      if (before.lastWorkspace) activateWorkspaceView(before.lastWorkspace);
      writeWorkspaces({ lastWorkspace: before.lastWorkspace, recent: before.recent ?? [] });
    }

    if (SELFTEST_MODE === "fork2") {
      const tree = await js<{ tree?: any[] }>("window.api.getTree()");
      const stack = [...(tree.tree ?? [])];
      let entryId: string | null = null;
      while (stack.length) {
        const node = stack.pop();
        if (node.entry?.message?.role === "user") {
          entryId = node.entry.id;
          break;
        }
        stack.push(...(node.children ?? []));
      }
      const fork = entryId
        ? await js<{ cancelled: boolean }>(`window.api.fork(${JSON.stringify(entryId)})`)
        : { cancelled: true };
      await sleep(500);
      if (!fork.cancelled) {
        await js('window.api.prompt("只回复：forked")');
        await sleep(9000);
      }
      const messages = await js<Array<{ role: string; content: any }>>("window.api.getMessages()");
      const texts = messages
        .filter((m) => m.role === "assistant")
        .map((m) => (Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : String(m.content)));
      console.log(
        "P1_SELFTEST_FORK2 " +
          JSON.stringify({
            fork,
            messages: messages.length,
            hasForked: texts.some((t) => t.includes("forked")),
          }),
      );
    }

    if (SELFTEST_MODE === "switch") {
      let sessions: Array<{ sessionFile: string }> = [];
      let state: { sessionFile?: string } = {};
      try {
        sessions = await js<Array<{ sessionFile: string }>>("window.api.getSessions()");
        state = await js<{ sessionFile?: string }>("window.api.getState()");
      } catch (err) {
        console.log("P1_SELFTEST_SWITCH_ERROR " + String(err));
      }
      const target = sessions.find((s) => s.sessionFile !== state.sessionFile) ?? sessions[0];
      let ok = false;
      let messages = 0;
      if (target) {
        try {
          ok = await js<boolean>(
            `window.api.switchSession(${JSON.stringify(target.sessionFile)})`,
          );
          const list = await js<unknown[]>("window.api.getMessages()");
          messages = list.length;
        } catch (err) {
          console.log("P1_SELFTEST_SWITCH_OP_ERROR " + String(err));
        }
      }
      console.log(
        "P1_SELFTEST_SWITCH " +
          JSON.stringify({ sessions: sessions.length, ok, messages }),
      );
    }
  } catch (err) {
    console.error("P1_SELFTEST_MODE_ERROR", err);
  } finally {
    app.quit();
  }
}

app.whenReady().then(async () => {
  stateFile = join(app.getPath("userData"), "state.json");
  workspacesFile = join(app.getPath("userData"), "workspaces.json");
  exportsDir = join(app.getPath("userData"), "exports");
  screenshotsDir = join(app.getPath("userData"), "screenshots");
  logsDir = join(app.getPath("userData"), "logs");
  settingsFile = join(app.getPath("userData"), "settings.json");

  loadSettings();
  // 设置文件里的上限在 RuntimeManager 创建之后才读入，启动时要同步一次
  runtimeManager.setMaxRuntimes(appSettings.maxRuntimes);
  slotPool.setMaxSlots(appSettings.maxRuntimes);

  grants = new GrantStore(join(app.getPath("userData"), "grants.json"));
  secretStore = new SecretStore(join(app.getPath("userData"), "secrets.json"));

  // P3：启动后异步检查一次 MCP 连接。不阻塞会话、不弹窗；
  // 结果进 mcp-service 的缓存，设置页打开时能看到。
  if (!SELFTEST) {
    setTimeout(() => {
      void getMcpService().check().catch(() => undefined);
    }, 8000);
  }
  auditLog = new AuditLog(() => auditFile());
  policyService = new PolicyService({
    getWorkspaceRoot: () => workspaceRoot,
    getSessionKey: () => currentSessionFile ?? "session:none",
    grants,
    audit: (entry) => auditLog?.write(entry),
    getSettingsPolicy: () => settingsPolicyPath,
    // 修改 4 · M2：方案期与权限档都按会话取，A 批准了不代表 B 也批准
    getPlanGate: (ctx) => {
      const gate = planGateFor(planKeyOf(ctx));
      return { enabled: gate.enabled, approved: gate.approved };
    },
    revalidatePlan: (ctx) => revalidatePlanGate(planKeyOf(ctx)),
    modeFor: (ctx) => permissionModeFor(ctx),
    resolveRuntime: (token) => {
      const binding = runtimeManager.services.resolve(token);
      return binding
        ? {
            runtimeId: binding.runtimeId,
            workspace: binding.workspace,
            ...(binding.session ? { sessionKey: binding.session } : {}),
            audit: (entry: AuditEntry) => auditFor(binding.runtimeId)?.write(entry),
          }
        : undefined;
    },
    onChange: (info) => send("policy:changed", info),
    onError: (message) =>
      reportError({
        code: "E_TOOL_BLOCKED",
        severity: "error",
        title: "权限策略不可用，已全部拒绝",
        detail: "策略文件无法解析，工具调用已被拒绝",
        raw: message,
        recoverable: true,
        action: "open-settings",
      }),
  });
  await policyService.start();

  // 产物账本：扩展在每次工具结束后往这里写一条「谁产出了什么」
  artifactService = new ArtifactService(
    new ArtifactLedger(() => workspaceRoot),
    () => workspaceRoot,
    () => currentSessionFile ?? "session:none",
    (token) => {
      const binding = runtimeManager.services.resolve(token);
      return binding ? { runtimeId: binding.runtimeId, workspace: binding.workspace } : undefined;
    },
  );
  await artifactService.start();

  const persisted = readState();
  dailyDate = persisted.dailyDate || todayISO();
  dailySpent = persisted.dailySpent ?? 0;
  sessionCosts = persisted.sessionCosts ?? {};
  if (persisted.dailyDate && persisted.dailyDate !== todayISO()) {
    dailyDate = todayISO();
    dailySpent = 0;
  }

  const sidecarPath =
    process.env.OMCP_SIDECAR ||
    (app.isPackaged
      ? join(process.resourcesPath, "kernel-sidecar", "sidecar.py")
      : resolve(app.getAppPath(), "../../packages/kernel-sidecar/sidecar.py"));
  const extensionPath =
    process.env.OMCP_EXTENSION ||
    (app.isPackaged
      ? join(process.resourcesPath, "science-ext", "src", "index.ts")
      : resolve(app.getAppPath(), "../../packages/science-ext/src/index.ts"));
  // 生成的 spec 放应用私有目录，不写用户的 %APPDATA%\jupyter
  const kernelSpecDir = join(app.getPath("userData"), "kernels");
  kernelManager = new KernelManager(sidecarPath, app.getPath("userData"), kernelSpecDir);
  kernelManager.setPythonPath(appSettings.pythonPath);
  kernelManager.setRPath(appSettings.rPath);
  pointKernelsAt(currentSessionFile ?? null);
  /**
   * legacy 全局 token 那一支用的"默认对"。
   * 用取值器而不是快照：笔记本切会话时别名会换，broker 必须跟着换，
   * 否则老 token 会把请求送到上一个会话的内核里（正是要修的那条串台）。
   */
  const aliasPair = {
    get python(): KernelService {
      if (!pythonKernel) throw new Error("内核管理器尚未就绪");
      return pythonKernel;
    },
    get r(): KernelService {
      if (!rKernel) throw new Error("内核管理器尚未就绪");
      return rKernel;
    },
  };
  kernelBroker = new KernelBroker(
    aliasPair,
    (data) => {
      saveFigure(data);
    },
    // 纯文本模型：run_code 的图先转述成文字，不把 image block 塞给模型
    async (data: string, mimeType: string) => {
      if (!visionConfigured()) return null;
      if (forceTextOnlyForTest) return (await describeForVision(data, mimeType)).text;
      const supports = await modelSupportsImage();
      if (supports) return null;
      return (await describeForVision(data, mimeType)).text;
    },
    // 审计补 outcome：只记 allow 的日志复盘不了“哪一步失败”（自测报告 P4）
    (o) => {
      auditFor(o.runtimeId)?.write({
        ts: new Date().toISOString(),
        toolName: "run_code",
        ruleId: "kernel:execute",
        decision: "allow",
        scope: "outcome",
        summary:
          `${o.lang === "r" ? "R" : "Python"} 执行${o.ok ? "完成" : "失败"}` +
          ` · ${(o.durationMs / 1000).toFixed(1)}s · status=${o.status}` +
          (o.errorClass ? ` · ${o.errorClass}` : ""),
        sessionId: currentSessionFile ?? undefined,
        outcome: {
          ok: o.ok,
          durationMs: o.durationMs,
          status: o.status,
          ...(o.errorClass ? { errorClass: o.errorClass } : {}),
          ...(o.kernelPid ? { kernelPid: o.kernelPid } : {}),
        },
      });
    },
    // 修改 4 · M2：token → runtime → **会话** → 该会话的内核（换会话不再串台）
    (token) => {
      const binding = runtimeManager.services.resolve(token);
      if (!binding) return undefined;
      const key = kernelKeyFor(binding.session, binding.runtimeId);
      // get() 自己会 touch lastUsedAt，空闲回收据此判断
      const pair = kernelManager?.get(key, binding.workspace);
      return pair ? { runtimeId: binding.runtimeId, services: pair } : undefined;
    },
  );
  await kernelBroker.start();
  // 修改 4 · M4：子任务并发闸的入口（扩展进程来领名额）
  subagentGateServer = await startSubagentGateServer(subagentGate, {
    onError: (message) => console.error("[子任务闸]", message),
    // 子进程要继承这个槽**此刻**的 provider/model（env 是建进程那一刻的快照，换过模型就旧了）
    modelFor: (key) => {
      const runtime = runtimeManager.get(key);
      return {
        provider: runtime?.supervisor.getProvider() || undefined,
        model: runtime?.supervisor.getModel() || undefined,
        // 权限档也一起给：子任务没有审批通道，能拿哪些工具由它决定（0.7.1 · B1）
        mode: permissionModeFor({ runtimeId: key }),
      };
    },
  });
  browserService = new BrowserService({
    playwrightDir: app.isPackaged
      ? join(process.resourcesPath, "plugin-ext", "payload", "node_modules", "playwright-core")
      : resolve(app.getAppPath(), "../../packages/plugin-ext/node_modules/playwright-core"),
    getWorkspace: () => workspaceRoot,
    onError: (message) =>
      reportError({
        code: "E_TOOL_ERROR",
        severity: "warning",
        title: "浏览器操作失败",
        detail: "这次浏览器操作没有完成",
        raw: message.slice(0, 300),
        recoverable: true,
        action: "none",
      }),
  });
  await browserService.start();
  // 开发态：告诉解析器仓库根在哪，让它自己去 vendor/pi 找（不覆盖 OMCP_PI_PATH）
  if (!app.isPackaged && !process.env.OMCP_PI_DEV_ROOT) {
    process.env.OMCP_PI_DEV_ROOT = resolve(app.getAppPath(), "..", "..");
  }

  const permissionExtPath =
    process.env.OMCP_PERMISSION_EXT ||
    (app.isPackaged
      ? join(process.resourcesPath, "permission-ext", "src", "index.ts")
      : resolve(app.getAppPath(), "../../packages/permission-ext/src/index.ts"));
  // 打包态用 esbuild 打出的单文件（pnpm 的 node_modules 是软链，不能直接拷）
  const pluginExtPath =
    process.env.OMCP_PLUGIN_EXT ||
    (app.isPackaged
      ? join(process.resourcesPath, "plugin-ext", "index.mjs")
      : resolve(app.getAppPath(), "../../packages/plugin-ext/src/index.ts"));

  // 修改 4 · M4：子任务扩展（族开关 subagent，默认关）
  const subagentExtPath =
    process.env.OMCP_SUBAGENT_EXT ||
    (app.isPackaged
      ? join(process.resourcesPath, "subagent-ext", "src", "index.ts")
      : resolve(app.getAppPath(), "../../packages/subagent-ext/src/index.ts"));

  applyRuntimeServiceEnv(defaultRuntime);
  // playwright-core 在 payload/node_modules（electron-builder 跳过根部 node_modules）
  defaultRuntime.setEnv(
    "OMCP_PLAYWRIGHT_CORE",
    app.isPackaged
      ? join(process.resourcesPath, "plugin-ext", "payload", "node_modules", "playwright-core")
      : "",
  );
  if (appSettings.piConfigDir) {
    defaultRuntime.setEnv("PI_CODING_AGENT_DIR", appSettings.piConfigDir);
  }
  runtimeExtensions = [extensionPath, permissionExtPath, pluginExtPath, subagentExtPath];
  defaultRuntime.setExtensions(runtimeExtensions);

  const ws = readWorkspaces();
  const initial = ws.lastWorkspace ?? join(app.getPath("userData"), "workspace");
  await openWorkspace(initial);
  applyPermissionMode();
  await createWindow();

  if (SELFTEST && ["tool", "stop", "switch", "fork2", "workspace", "multiws", "m5", "kernel", "notebook", "rnotebook", "a1", "a3", "grant", "readonly", "timeout", "abort", "readonly-notebook", "p40", "a4", "p42", "perf", "perflong", "ready", "kernelbench", "uploadcheck", "layoutcheck", "sidebarcheck", "a2a5", "p50", "p51", "p52", "p53", "p54", "rc", "piinfo", "piiso", "policy", "stability"].includes(SELFTEST_MODE)) {
    setTimeout(() => void runSelftestMode(), 3200);
  }

  if (SELFTEST && SELFTEST_MODE === "budget") {
    setTimeout(async () => {
      try {
        const ok = await win!.webContents.executeJavaScript('window.api.prompt("budget-test")');
        await new Promise((r) => setTimeout(r, 700));
        const text = await win!.webContents.executeJavaScript("document.body.innerText");
        console.log(
          "P1_SELFTEST_BUDGET " +
            JSON.stringify({ ok, blocked: /预算/.test(text), hasError: /预算/.test(text) }),
        );
      } catch (err) {
        console.error("P1_SELFTEST_BUDGET_ERROR", err);
      } finally {
        app.quit();
      }
    }, 2200);
  }
  if (SELFTEST) {
    selftestTimer = setTimeout(() => {
      if (selftestDone) return;
      selftestDone = true;
      console.error("P1_SELFTEST_TIMEOUT");
      console.log("P1_SELFTEST_TEXT_START");
      console.log("(timeout)");
      console.log("P1_SELFTEST_TEXT_END");
      console.log("P1_SELFTEST_OK false");
      app.quit();
    }, ["timeout", "p51", "p52", "p53", "p54", "rc", "piinfo", "piiso", "a3", "a4", "perf", "perflong"].includes(SELFTEST_MODE) ? 300_000 : 120_000);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  defaultRuntime.stop();
  app.quit();
});

app.on("before-quit", () => {
  artifactService?.stop();
  void browserService?.stop().catch(() => undefined);
});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  try {
    appendFileSync(
      join(app.getPath("userData"), "quit.log"),
      JSON.stringify({ python: pythonKernel?.pid, r: rKernel?.pid }) + "\n",
      "utf8",
    );
  } catch {
    // ignore
  }
  clearAbortTimer();
  defaultRuntime.stop();
  for (const service of [pythonKernel, rKernel]) {
    const pid = service?.pid;
    if (pid) {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          detached: true,
        }).unref();
      } catch {
        // ignore
      }
    }
  }
  // 内核按会话记（M2）：退出一律全关，别只关当前可见的那一对
  kernelManager?.disposeAll();
  kernelBroker?.stop();
  subagentGate.dispose();
  subagentGateServer?.close();
  setTimeout(() => app.quit(), 800);
  event.preventDefault();
});
