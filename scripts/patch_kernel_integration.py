from pathlib import Path

p = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "src" / "main" / "index.ts"
s = p.read_text(encoding="utf-8")

s = s.replace(
    'import { PiSupervisor } from "./supervisor";\nimport { RpcClient } from "./rpc-client";',
    'import { PiSupervisor } from "./supervisor";\nimport { RpcClient } from "./rpc-client";\nimport { KernelService } from "./kernel-service";\nimport { KernelBroker } from "./kernel-broker";',
)
s = s.replace(
    "const supervisor = new PiSupervisor();\nconst rpc = new RpcClient();",
    "const supervisor = new PiSupervisor();\nconst rpc = new RpcClient();\nlet kernelService: KernelService | null = null;\nlet kernelBroker: KernelBroker | null = null;",
)
s = s.replace(
    "  workspaceRoot = resolved;\n  sessionDir = newSessionDir;",
    "  workspaceRoot = resolved;\n  kernelService?.setWorkspace(resolved);\n  sessionDir = newSessionDir;",
)
s = s.replace(
    '  const ws = readWorkspaces();\n  const initial = ws.lastWorkspace ?? join(app.getPath("userData"), "workspace");\n  await openWorkspace(initial);',
    '''  const sidecarPath =
    process.env.OMCP_SIDECAR ||
    resolve(app.getAppPath(), "../../packages/kernel-sidecar/sidecar.py");
  const extensionPath =
    process.env.OMCP_EXTENSION ||
    resolve(app.getAppPath(), "../../packages/science-ext/src/index.ts");
  kernelService = new KernelService(sidecarPath, app.getPath("userData"));
  kernelBroker = new KernelBroker(kernelService);
  await kernelBroker.start();
  supervisor.setExtraEnv({
    OMCP_KERNEL_URL: kernelBroker.url,
    OMCP_KERNEL_TOKEN: kernelBroker.token,
  });
  supervisor.setExtension(extensionPath);

  const ws = readWorkspaces();
  const initial = ws.lastWorkspace ?? join(app.getPath("userData"), "workspace");
  await openWorkspace(initial);''',
)
s = s.replace(
    'app.on("before-quit", () => {\n  clearAbortTimer();\n  supervisor.stop();\n});',
    'app.on("before-quit", () => {\n  clearAbortTimer();\n  supervisor.stop();\n  kernelService?.shutdown();\n  kernelBroker?.stop();\n});',
)

p.write_text(s, encoding="utf-8")
print("patched", p)
