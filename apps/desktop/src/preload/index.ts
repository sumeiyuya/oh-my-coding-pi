import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentMessage,
  AppError,
  BridgeStatus,
  BudgetStatus,
  ModelInfo,
  PiStreamItem,
  PromptResult,
  ForkResult,
  FileListResult,
  FileReadResult,
  FileStatResult,
  KernelRunEvent,
  NotebookCell,
  PermissionMode,
  PermissionState,
  SessionState,
  SetModelResult,
  ThinkingLevel,
  SessionStats,
  SessionMetaPatch,
  SessionMetaResult,
  SessionSummary,
  SessionSwitchResult,
  SessionTreeResult,
  TurnPhaseEvent,
  UploadKind,
  UploadProgress,
  WorkspaceInfo,
  WorkspaceIndexEntry,
  WorkspaceOpenResult,
} from "@oh-my-coding-pi/shared";

contextBridge.exposeInMainWorld("api", {
  prompt: (
    text: string,
    images?: unknown,
    opts?: unknown,
    runtimeId?: string,
  ): Promise<PromptResult> => ipcRenderer.invoke("pi:prompt", text, images, opts, runtimeId),
  clearQueue: (runtimeId?: string): Promise<import("@oh-my-coding-pi/shared").ClearQueueResult> =>
    ipcRenderer.invoke("pi:clear-queue", runtimeId),
  steer: (text: string, runtimeId?: string): Promise<PromptResult> => ipcRenderer.invoke("pi:steer", text, runtimeId),
  followUp: (text: string, runtimeId?: string): Promise<PromptResult> => ipcRenderer.invoke("pi:follow-up", text, runtimeId),
  abort: (runtimeId?: string): Promise<boolean> => ipcRenderer.invoke("pi:abort", runtimeId),
  restart: (): Promise<boolean> => ipcRenderer.invoke("pi:restart"),
  newSession: (runtimeId?: string): Promise<boolean> => ipcRenderer.invoke("pi:new-session", runtimeId),
  getSessions: (runtimeId?: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke("pi:sessions", runtimeId),
  getSessionMeta: (): Promise<SessionMetaResult> => ipcRenderer.invoke("session-meta:get"),
  setSessionMeta: (sessionFile: string, patch: SessionMetaPatch): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("session-meta:set", sessionFile, patch),
  listFiles: (path: string): Promise<FileListResult> => ipcRenderer.invoke("fs:list", path),
  listArtifacts: (): Promise<import("@oh-my-coding-pi/shared").ArtifactListResult> =>
    ipcRenderer.invoke("artifacts:list"),
  statFile: (path: string): Promise<FileStatResult> => ipcRenderer.invoke("fs:stat", path),
  readFile: (path: string): Promise<FileReadResult> => ipcRenderer.invoke("fs:read", path),
  getModelRegistry: (): Promise<unknown> => ipcRenderer.invoke("models:registry-get"),
  setModelRegistry: (raw: unknown): Promise<unknown> => ipcRenderer.invoke("models:registry-set", raw),
  importModelRegistry: (): Promise<unknown> => ipcRenderer.invoke("models:import"),
  setModelProviderKey: (id: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke("models:key-set", id, key),
  modelPreflight: (provider: string, modelId: string): Promise<unknown> =>
    ipcRenderer.invoke("model:preflight", provider, modelId),
  modelSetupInfo: (provider: string): Promise<unknown> =>
    ipcRenderer.invoke("model:setup-info", provider),
  modelSetupSave: (input: unknown): Promise<unknown> =>
    ipcRenderer.invoke("model:setup-save", input),
  testModelProvider: (id: string): Promise<unknown> => ipcRenderer.invoke("models:test", id),
  detectKernels: (language: "python" | "r"): Promise<unknown> =>
    ipcRenderer.invoke("kernel:detect", language),
  getKernelStatus: (): Promise<unknown> => ipcRenderer.invoke("kernel:status"),
  saveKernelPath: (language: "python" | "r", path: string): Promise<unknown> =>
    ipcRenderer.invoke("kernel:save-path", language, path),
  listKernelSpecs: (): Promise<unknown> => ipcRenderer.invoke("kernel:specs"),
  getProviderCatalog: (): Promise<unknown> => ipcRenderer.invoke("models:catalog"),
  probeModelEndpoint: (baseUrl: string, apiKey: string, api?: string): Promise<unknown> =>
    ipcRenderer.invoke("models:probe", baseUrl, apiKey, api),
  addModelProvider: (input: unknown): Promise<unknown> => ipcRenderer.invoke("models:add-provider", input),
  getUsage: (): Promise<unknown> => ipcRenderer.invoke("usage:get"),
  getPermission: (): Promise<PermissionState> => ipcRenderer.invoke("permission:get"),
  setPermission: (mode: PermissionMode, asDefault: boolean): Promise<PermissionState> =>
    ipcRenderer.invoke("permission:set", mode, asDefault),
  listPlugins: (): Promise<unknown> => ipcRenderer.invoke("plugins:list"),
  setPluginFlag: (pluginId: string, familyKey: string | null, on: boolean): Promise<unknown> =>
    ipcRenderer.invoke("plugins:set", pluginId, familyKey, on),
  memoryList: (): Promise<unknown> => ipcRenderer.invoke("memory:list"),
  memoryAdopt: (id: string): Promise<unknown> => ipcRenderer.invoke("memory:adopt", id),
  memoryReject: (id: string): Promise<unknown> => ipcRenderer.invoke("memory:reject", id),
  switchSession: (sessionFile: string): Promise<boolean> =>
    ipcRenderer.invoke("pi:switch-session", sessionFile),
  getMessages: (): Promise<AgentMessage[]> => ipcRenderer.invoke("pi:messages"),
  getTree: (): Promise<SessionTreeResult> => ipcRenderer.invoke("pi:tree"),
  fork: (entryId: string, runtimeId?: string): Promise<ForkResult> =>
    ipcRenderer.invoke("pi:fork", entryId, runtimeId),
  clone: (runtimeId?: string): Promise<SessionSwitchResult> =>
    ipcRenderer.invoke("pi:clone", runtimeId),
  exportHtml: (outputPath?: string): Promise<string | null> =>
    ipcRenderer.invoke("pi:export-html", outputPath),
  getAvailableModels: (): Promise<ModelInfo[]> => ipcRenderer.invoke("pi:models"),
  getThinkingLevels: (runtimeId?: string): Promise<ThinkingLevel[]> =>
    ipcRenderer.invoke("pi:thinking-levels", runtimeId),
  setThinkingLevel: (level: ThinkingLevel, runtimeId?: string): Promise<SetModelResult> =>
    ipcRenderer.invoke("pi:set-thinking-level", level, runtimeId),
  setModel: (provider: string, modelId: string, runtimeId?: string): Promise<SetModelResult> =>
    ipcRenderer.invoke("pi:set-model", provider, modelId, runtimeId),
  getState: (): Promise<SessionState> => ipcRenderer.invoke("pi:state"),
  getStats: (): Promise<SessionStats> => ipcRenderer.invoke("pi:stats"),
  getBudget: (): Promise<BudgetStatus> => ipcRenderer.invoke("pi:budget"),
  getWorkspace: (): Promise<WorkspaceInfo> => ipcRenderer.invoke("workspace:current"),
  getWorkspaceIndex: (): Promise<WorkspaceIndexEntry[]> => ipcRenderer.invoke("workspace:index"),
  deleteSession: (sessionFile: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("session:delete", sessionFile),
  pickWorkspace: (): Promise<WorkspaceOpenResult | null> => ipcRenderer.invoke("workspace:pick"),
  openWorkspace: (root: string): Promise<WorkspaceOpenResult> =>
    ipcRenderer.invoke("workspace:open", root),
  onEvent: (cb: (item: PiStreamItem) => void): (() => void) => {
    const listener = (_event: unknown, item: PiStreamItem) => cb(item);
    ipcRenderer.on("pi:event", listener);
    return () => ipcRenderer.removeListener("pi:event", listener);
  },
  onTurnPhase: (cb: (event: TurnPhaseEvent) => void): (() => void) => {
    const listener = (_event: unknown, ev: TurnPhaseEvent) => cb(ev);
    ipcRenderer.on("pi:turn", listener);
    return () => ipcRenderer.removeListener("pi:turn", listener);
  },
  pickUpload: (kind: UploadKind) => ipcRenderer.invoke("upload:pick", kind),
  importUploads: (paths: string[], importId: string) =>
    ipcRenderer.invoke("upload:import", { paths, importId }),
  cancelUpload: (importId: string) => ipcRenderer.invoke("upload:cancel", importId),
  onUploadProgress: (cb: (progress: UploadProgress) => void) => {
    const listener = (_event: unknown, progress: UploadProgress) => cb(progress);
    ipcRenderer.on("upload:progress", listener);
    return () => ipcRenderer.removeListener("upload:progress", listener);
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  isPiReady: (): Promise<boolean> => ipcRenderer.invoke("pi:ready"),
  onPiReady: (cb: (ready: boolean) => void): (() => void) => {
    const listener = (_event: unknown, ready: boolean) => cb(ready);
    ipcRenderer.on("bridge:pi-ready", listener);
    return () => ipcRenderer.removeListener("bridge:pi-ready", listener);
  },
  onStatus: (cb: (status: BridgeStatus) => void): (() => void) => {
    const listener = (_event: unknown, status: BridgeStatus) => cb(status);
    ipcRenderer.on("bridge:status", listener);
    return () => ipcRenderer.removeListener("bridge:status", listener);
  },
  onError: (cb: (error: AppError) => void): (() => void) => {
    const listener = (_event: unknown, error: AppError) => cb(error);
    ipcRenderer.on("bridge:error", listener);
    return () => ipcRenderer.removeListener("bridge:error", listener);
  },
  onWorkspace: (cb: (info: WorkspaceInfo) => void): (() => void) => {
    const listener = (_event: unknown, info: WorkspaceInfo) => cb(info);
    ipcRenderer.on("workspace:changed", listener);
    return () => ipcRenderer.removeListener("workspace:changed", listener);
  },
  respondApproval: (decision: { requestId: string; scope: string; decidedAt: string }): Promise<void> =>
    ipcRenderer.invoke("approval:respond", decision),
  onApproval: (cb: (req: unknown) => void): (() => void) => {
    const listener = (_event: unknown, req: unknown) => cb(req);
    ipcRenderer.on("approval:request", listener);
    return () => ipcRenderer.removeListener("approval:request", listener);
  },
  onApprovalResolved: (cb: (info: { requestId: string; scope: string }) => void): (() => void) => {
    const listener = (_event: unknown, info: { requestId: string; scope: string }) => cb(info);
    ipcRenderer.on("approval:resolved", listener);
    return () => ipcRenderer.removeListener("approval:resolved", listener);
  },
  onPolicyChanged: (cb: (info: unknown) => void): (() => void) => {
    const listener = (_event: unknown, info: unknown) => cb(info);
    ipcRenderer.on("policy:changed", listener);
    return () => ipcRenderer.removeListener("policy:changed", listener);
  },
  getPolicy: (): Promise<unknown> => ipcRenderer.invoke("policy:current"),
  reloadPolicy: (): Promise<unknown> => ipcRenderer.invoke("policy:reload"),
  listGrants: (): Promise<unknown[]> => ipcRenderer.invoke("grants:list"),
  revokeGrant: (id: string): Promise<boolean> => ipcRenderer.invoke("grants:revoke", id),
  clearGrants: (): Promise<boolean> => ipcRenderer.invoke("grants:clear"),
  readAudit: (limit?: number): Promise<unknown[]> => ipcRenderer.invoke("audit:read", limit),
  queryAudit: (query?: unknown): Promise<unknown> => ipcRenderer.invoke("audit:query", query),
  getAppSettings: (): Promise<unknown> => ipcRenderer.invoke("settings:app"),
  setAppSettings: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("settings:app:set", patch),
  pruneGrants: (): Promise<number> => ipcRenderer.invoke("grants:prune"),
  getSettingsDetail: (): Promise<unknown> => ipcRenderer.invoke("settings:detail"),
  updateSettingsDetail: (patch: unknown): Promise<unknown> =>
    ipcRenderer.invoke("settings:detail:set", patch),
  checkUpdate: (): Promise<unknown> => ipcRenderer.invoke("update:check"),
  exportDiagnostics: (): Promise<string | null> => ipcRenderer.invoke("diag:export"),
  openExternal: (url: string): Promise<unknown> => ipcRenderer.invoke("shell:open-external", url),
  signalReady: (): void => ipcRenderer.send("app:ready"),
  /* MCP（P1） */
  listMcpServers: (): Promise<unknown> => ipcRenderer.invoke("mcp:list"),
  checkMcpServers: (name?: string): Promise<unknown> => ipcRenderer.invoke("mcp:check", name),
  saveMcpServer: (input: unknown): Promise<unknown> => ipcRenderer.invoke("mcp:save", input),
  removeMcpServer: (name: string): Promise<unknown> => ipcRenderer.invoke("mcp:remove", name),
  setMcpFlag: (
    name: string,
    flag: string,
    value: boolean,
    fingerprint?: string,
  ): Promise<unknown> => ipcRenderer.invoke("mcp:flag", { name, flag, value, fingerprint }),
  setMcpSecret: (name: string, key: string, value: string): Promise<unknown> =>
    ipcRenderer.invoke("mcp:secret", { name, key, value }),
  openMcpConfig: (): Promise<unknown> => ipcRenderer.invoke("mcp:open-config"),
  loginMcpServer: (name: string): Promise<unknown> => ipcRenderer.invoke("mcp:login", name),
  listRuntimes: (): Promise<unknown> => ipcRenderer.invoke("runtime:list"),
  getRuntimeMessages: (id: string): Promise<unknown> => ipcRenderer.invoke("runtime:messages", id),
  getRuntimeState: (id: string): Promise<unknown> => ipcRenderer.invoke("runtime:state", id),
  getRuntimeStats: (id: string): Promise<unknown> => ipcRenderer.invoke("runtime:stats", id),
  onRuntimeChanged: (cb: (list: unknown) => void): (() => void) => {
    const listener = (_event: unknown, list: unknown) => cb(list);
    ipcRenderer.on("runtime:changed", listener);
    return () => ipcRenderer.removeListener("runtime:changed", listener);
  },
  createRuntime: (input?: unknown): Promise<unknown> => ipcRenderer.invoke("runtime:create", input),
  activateRuntime: (id: string): Promise<unknown> => ipcRenderer.invoke("runtime:activate", id),
  closeRuntime: (id: string): Promise<unknown> => ipcRenderer.invoke("runtime:close", id),
  // 修改 4 · M0：会话级入口
  getSessionBoard: (): Promise<unknown> => ipcRenderer.invoke("session:board"),
  openSession: (file: string): Promise<unknown> => ipcRenderer.invoke("session:open", file),
  closeSession: (file: string): Promise<unknown> => ipcRenderer.invoke("session:close", file),
  onSessionChanged: (cb: (board: unknown) => void): (() => void) => {
    const listener = (_event: unknown, board: unknown) => cb(board);
    ipcRenderer.on("session:changed", listener);
    return () => ipcRenderer.removeListener("session:changed", listener);
  },
  onKernelReaped: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("session:kernel-reaped", listener);
    return () => ipcRenderer.removeListener("session:kernel-reaped", listener);
  },
  onSessionOpened: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_event: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on("session:opened", listener);
    return () => ipcRenderer.removeListener("session:opened", listener);
  },
  loadRoute: (): Promise<unknown> => ipcRenderer.invoke("route:load"),
  saveRoute: (doc: unknown): Promise<unknown> => ipcRenderer.invoke("route:save", doc),
  exportRoute: (): Promise<unknown> => ipcRenderer.invoke("route:export"),
  getPlanStatus: (): Promise<unknown> => ipcRenderer.invoke("plan:status"),
  setPlanMode: (enabled: boolean): Promise<unknown> => ipcRenderer.invoke("plan:set", enabled),
  approvePlan: (planPath: string): Promise<unknown> => ipcRenderer.invoke("plan:approve", planPath),
  getPiInfo: (): Promise<unknown> => ipcRenderer.invoke("pi:info"),
  getVisionSettings: (): Promise<unknown> => ipcRenderer.invoke("vision:get"),
  setVisionSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke("vision:set", patch),
  testVision: (): Promise<unknown> => ipcRenderer.invoke("vision:test"),
  describeImage: (data: string, mimeType?: string): Promise<unknown> =>
    ipcRenderer.invoke("vision:describe", data, mimeType),
  listSkills: (): Promise<unknown[]> => ipcRenderer.invoke("skills:list"),
  readSkill: (name: string): Promise<string | null> => ipcRenderer.invoke("skills:read", name),
  setSkillEnabled: (name: string, enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("skills:set-enabled", name, enabled),
  createSkill: (slug: string, description: string): Promise<string | null> =>
    ipcRenderer.invoke("skills:create", slug, description),
  exportAudit: (): Promise<string | null> => ipcRenderer.invoke("audit:export"),
  loadNotebook: (): Promise<NotebookCell[]> => ipcRenderer.invoke("notebook:load"),
  saveNotebook: (cells: NotebookCell[]): Promise<boolean> =>
    ipcRenderer.invoke("notebook:save", cells),
  runCell: (runId: string, code: string, language?: "python" | "r"): Promise<boolean> =>
    ipcRenderer.invoke("kernel:run", { runId, code, language }),
  interruptKernel: (language?: "python" | "r"): Promise<boolean> =>
    ipcRenderer.invoke("kernel:interrupt", language),
  restartKernel: (language?: "python" | "r"): Promise<boolean> =>
    ipcRenderer.invoke("kernel:restart", language),
  getVariables: (language?: "python" | "r"): Promise<string[]> =>
    ipcRenderer.invoke("kernel:variables", language),
  onKernelEvent: (cb: (ev: KernelRunEvent) => void): (() => void) => {
    const listener = (_event: unknown, ev: KernelRunEvent) => cb(ev);
    ipcRenderer.on("kernel:event", listener);
    return () => ipcRenderer.removeListener("kernel:event", listener);
  },
});
