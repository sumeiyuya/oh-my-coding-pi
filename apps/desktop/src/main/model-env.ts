/**
 * 凭据的环境变量名（P1-01 修复的核心）。
 *
 * 问题背景：内置 provider（deepseek / openai / anthropic…）只认 pi 官方变量名，
 * 而我们过去统一注入 `OMCP_KEY_<ID>`，于是「密钥存了、pi 却说没有」。
 *
 * 规则：
 * - 内置 provider：注入 pi-ai 给的官方名（DEEPSEEK_API_KEY 等），来自 provider-catalog；
 * - 所有 provider 同时注入 `OMCP_KEY_<ID>`，供我们自己生成的 models.json 引用；
 * - 两者合并、去重、保序（官方名在前）。
 */
/** 本应用自己的变量名：OMCP_KEY_<ID>（非字母数字转下划线） */
export function providerEnvKey(id: string): string {
  return "OMCP_KEY_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function credentialEnvNames(
  providerId: string,
  officialEnvKeys: readonly string[] | undefined,
): string[] {
  const out: string[] = [];
  for (const name of officialEnvKeys ?? []) {
    const trimmed = String(name ?? "").trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  const ours = providerEnvKey(providerId);
  if (!out.includes(ours)) out.push(ours);
  return out;
}

/**
 * 这个 provider 的凭据是否已经能从环境里拿到（只做变量名存在性判断，不读值）。
 * 用于启动时决定「还要不要额外注入」，以及给 UI 报告凭据来源。
 */
export function hasEnvCredential(
  providerId: string,
  officialEnvKeys: readonly string[] | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return credentialEnvNames(providerId, officialEnvKeys).some((name) => Boolean(env[name]));
}
