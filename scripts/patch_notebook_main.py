from pathlib import Path

p = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "src" / "main" / "index.ts"
s = p.read_text(encoding="utf-8")

s = s.replace(
    'import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";',
    'import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";',
)
s = s.replace(
    "  KernelService",
    "  KernelService",  # no-op anchor
)
s = s.replace(
    "  ModelInfo,\n  PiEvent,",
    "  KernelRunEvent,\n  ModelInfo,\n  NotebookCell,\n  PiEvent,",
)

helper = '''
function notebookPath(): string {
  if (!workspaceRoot) return join(app.getPath("userData"), "notebook.json");
  return join(workspaceRoot, ".omcp", "notebooks", "default.json");
}

'''
anchor = 'function listSessions(): SessionSummary[] {'
s = s.replace(anchor, helper + anchor, 1)

handlers = '''ipcMain.handle("notebook:load", () => {
  try {
    const data = JSON.parse(readFileSync(notebookPath(), "utf8")) as { cells?: NotebookCell[] };
    if (Array.isArray(data.cells)) return data.cells;
  } catch {
    // fall through
  }
  return [{ id: "cell-1", language: "python", code: "# Python\\n" }] satisfies NotebookCell[];
});

ipcMain.handle("notebook:save", (_event, cells: NotebookCell[]) => {
  const file = notebookPath();
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify({ cells }, null, 2) + "\\n", "utf8");
  renameSync(tmp, file);
  return true;
});

ipcMain.handle("kernel:run", async (_event, args: { runId: string; code: string }) => {
  if (!kernelService) return false;
  try {
    await kernelService.execute(args.code, (ev) => {
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
});

ipcMain.handle("kernel:interrupt", async () => {
  await kernelService?.interrupt();
  return true;
});

ipcMain.handle("kernel:restart", async () => {
  await kernelService?.restart();
  return true;
});

ipcMain.handle("kernel:variables", async () => {
  return (await kernelService?.variables()) ?? [];
});

'''
anchor2 = 'ipcMain.handle("workspace:current", () => ({'
s = s.replace(anchor2, handlers + anchor2, 1)

p.write_text(s, encoding="utf-8")
print("patched", p)
