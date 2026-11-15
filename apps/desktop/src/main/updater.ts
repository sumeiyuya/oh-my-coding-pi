import { isNewerVersion, type UpdateCheckResult, type UpdateErrorKind } from "@oh-my-coding-pi/shared";

const USER_AGENT = "oh-my-coding-pi-updater";

interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  assets?: Array<{ name?: string; browser_download_url?: string }>;
}

/** HTTP 非 2xx：带上状态码抛出，让上层能把 401/403/404/429 分开。 */
class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpStatusError(res.status);
  return res.text();
}

/**
 * 把异常翻成“用户能据此行动”的六类。
 * 分类只为给不同提示，不改变任何网络行为（仍然无认证、无 token）。
 */
export function classifyUpdateFailure(err: unknown): { kind: UpdateErrorKind; message: string } {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === "HttpStatusError") {
    const status = Number(e.status ?? 0);
    if (status === 401 || status === 403) {
      return {
        kind: "auth",
        message: `仓库不可访问（HTTP ${status}）：可能是私有仓库，或当前网络被限制。`,
      };
    }
    if (status === 404) {
      return { kind: "not_found", message: "仓库或 release 不存在（HTTP 404）：检查更新源是否填对。" };
    }
    if (status === 429) {
      return { kind: "ratelimit", message: "请求过于频繁（HTTP 429）：稍后再试。" };
    }
    if (status >= 500) {
      return { kind: "network", message: `GitHub 返回 HTTP ${status}：服务端暂时不可用。` };
    }
    return { kind: "network", message: `GitHub 返回 HTTP ${status}。` };
  }
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return { kind: "timeout", message: "请求超时：网络可能不通，或需要代理。" };
  }
  return { kind: "network", message: `网络请求失败：${e?.message ?? "未知错误"}` };
}

/**
 * 手动检查更新：读 GitHub Release latest，比较版本，取发布页的校验和资产。
 * 不做静默下载/安装（ADR-002 / d2）。
 */
export async function checkForUpdate(
  current: string,
  repo: string,
  timeoutMs = 10_000,
): Promise<UpdateCheckResult> {
  const trimmed = String(repo ?? "").trim();
  if (!trimmed) return { configured: false, current };
  if (!/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return { configured: true, current, error: "更新源格式应为 owner/repo" };
  }

  let raw: string;
  try {
    raw = await fetchText(`https://api.github.com/repos/${trimmed}/releases/latest`, timeoutMs);
  } catch (err) {
    const { kind, message } = classifyUpdateFailure(err);
    return { configured: true, current, errorKind: kind, error: `检查更新失败：${message}` };
  }

  let data: GithubRelease;
  try {
    data = JSON.parse(raw) as GithubRelease;
  } catch {
    return {
      configured: true,
      current,
      errorKind: "parse",
      error: "检查更新失败：发布信息不是有效 JSON。",
    };
  }
  const latest = String(data.tag_name ?? "").replace(/^v/i, "").trim();
  if (!latest) {
    return {
      configured: true,
      current,
      errorKind: "parse",
      error: "检查更新失败：发布信息里没有 tag_name。",
    };
  }

  const assets = data.assets ?? [];
  const checksumAsset = assets.find((a) => /sha256|checksums?/i.test(a.name ?? ""));
  let sha256: string | null = null;
  if (checksumAsset?.browser_download_url) {
    try {
      sha256 = (await fetchText(checksumAsset.browser_download_url, timeoutMs)).slice(0, 4000);
    } catch {
      // 校验和取不到不影响“有没有新版本”这个结论，只标记为 null
      sha256 = null;
    }
  }

  return {
    configured: true,
    current,
    latest,
    hasUpdate: isNewerVersion(current, latest),
    url: data.html_url,
    notes: (data.body ?? "").slice(0, 2000),
    publishedAt: data.published_at,
    sha256,
  };
}
