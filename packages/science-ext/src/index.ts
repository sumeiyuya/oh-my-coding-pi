type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}

interface ExtensionAPI {
  registerTool(definition: Record<string, unknown>): void;
}

const MAX_IMAGES = 5;

async function post(base: string, token: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export default function scienceExt(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "run_code",
    label: "Run Code",
    description:
      "Execute Python in the workspace's persistent Jupyter kernel. Variables persist across calls; matplotlib figures are returned as images. Use this for data analysis, statistics and plotting.",
    promptSnippet:
      "run_code: execute Python in the workspace kernel; matplotlib figures return as images",
    promptGuidelines: [
      "Use run_code when the user asks to compute, analyze data, or draw a matplotlib figure in Python.",
    ],
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Code to execute" },
        language: {
          type: "string",
          enum: ["python", "r"],
          description: "Kernel language (default python)",
        },
        timeout: { type: "number", description: "Timeout in seconds (default 120)" },
      },
      required: ["code"],
      additionalProperties: false,
    },
    async execute(
      _toolCallId: string,
      params: { code: string; language?: "python" | "r"; timeout?: number },
      signal: AbortSignal,
      onUpdate?: (update: { content: ContentBlock[] }) => void,
    ): Promise<ToolResult> {
      const base = process.env.OMCP_KERNEL_URL;
      const token = process.env.OMCP_KERNEL_TOKEN;
      if (!base || !token) throw new Error("kernel broker is not configured");

      const controller = new AbortController();
      const onAbort = () => {
        void post(base, token, "/interrupt").catch(() => undefined);
        controller.abort();
      };
      if (signal.aborted) onAbort();
      signal.addEventListener("abort", onAbort, { once: true });

      const timeoutMs = Math.max(1, params.timeout ?? 120) * 1000;
      const timer = setTimeout(onAbort, timeoutMs);

      let text = "";
      const images: string[] = [];
      let status = "unknown";

      try {
        const res = await fetch(`${base}/execute`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            code: params.code,
            lang: params.language ?? "python",
            timeoutMs,
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`kernel broker returned ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const handle = (line: string) => {
          if (!line.trim()) return;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.ev === "stream") {
            text += ev.text ?? "";
            onUpdate?.({ content: [{ type: "text", text: text.slice(-4000) }] });
          } else if (ev.ev === "display" && ev.mime === "image/png" && ev.data) {
            images.push(ev.data);
          } else if (ev.ev === "display" && ev.mime === "text/plain" && ev.text) {
            if (!String(ev.text).startsWith("<Figure")) text += ev.text;
          } else if (ev.ev === "error") {
            text += `[${ev.ename}] ${ev.evalue}\n`;
            if (Array.isArray(ev.traceback) && ev.traceback.length) {
              text += ev.traceback.join("\n") + "\n";
            }
          } else if (ev.ev === "result") {
            status = ev.status ?? "unknown";
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            handle(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
          }
        }
        if (buffer.trim()) handle(buffer);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }

      const content: ContentBlock[] = [
        { type: "text", text: text.trim() || "(no output)" },
      ];
      for (const data of images.slice(0, MAX_IMAGES)) {
        content.push({ type: "image", data, mimeType: "image/png" });
      }

      return {
        content,
        details: { status, images: images.length },
      };
    },
  });
}
