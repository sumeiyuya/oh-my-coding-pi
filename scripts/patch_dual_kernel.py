from pathlib import Path

p = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "src" / "main" / "index.ts"
s = p.read_text(encoding="utf-8")

s = s.replace(
    "let kernelService: KernelService | null = null;\nlet kernelBroker: KernelBroker | null = null;",
    "let pythonKernel: KernelService | null = null;\nlet rKernel: KernelService | null = null;\nlet kernelBroker: KernelBroker | null = null;",
)
s = s.replace(
    "  kernelService?.setWorkspace(resolved);",
    "  pythonKernel?.setWorkspace(resolved);\n  rKernel?.setWorkspace(resolved);",
)

old = '''ipcMain.handle("kernel:run", async (_event, args: { runId: string; code: string }) => {
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
});'''

new = '''ipcMain.handle(
  "kernel:run",
  async (_event, args: { runId: string; code: string; language?: "python" | "r" }) => {
    const service = args.language === "r" ? rKernel : pythonKernel;
    if (!service) return false;
    try {
      await service.execute(args.code, (ev) => {
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
});'''

s = s.replace(old, new)

s = s.replace(
    '  kernelService = new KernelService(sidecarPath, app.getPath("userData"));\n  kernelBroker = new KernelBroker(kernelService);',
    '  pythonKernel = new KernelService(sidecarPath, app.getPath("userData"), "python");\n  rKernel = new KernelService(sidecarPath, app.getPath("userData"), "r");\n  kernelBroker = new KernelBroker({ python: pythonKernel, r: rKernel });',
)
s = s.replace(
    "  kernelService?.shutdown();\n  kernelBroker?.stop();",
    "  pythonKernel?.shutdown();\n  rKernel?.shutdown();\n  kernelBroker?.stop();",
)

p.write_text(s, encoding="utf-8")
print("patched", p)
