import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@oh-my-coding-pi/shared";

/**
 * 模型目录（B1）：把「pi 实际可用的模型」与「这个 provider 有没有密钥」合到一处。
 *
 * 纪律（照 DAWN）：
 * - 只看 `getAvailableModels()`（available），不看配置里声明了什么；
 * - 取不到就是空数组，界面显示「去设置添加」，不假装有得选；
 * - 缺密钥的 provider 可以出现在列表里，但必须标出来。
 */

export interface ModelEntry {
  model: ModelInfo;
  /** 这个 provider 有没有存过密钥（来自注册表） */
  hasKey: boolean;
}

export interface ModelGroup {
  provider: string;
  /** 是否由本应用的配置层管理（内置 provider 在用户确认连接后也算） */
  managed: boolean;
  hasKey: boolean;
  /** 凭据来源；none 表示缺 */
  credentialSource: CredentialSource;
  models: ModelEntry[];
}

export type CredentialSource = "stored" | "env" | "auth" | "none" | "unknown";

export interface ModelCatalog {
  groups: ModelGroup[];
  /** 扁平顺序（键盘导航用），与分组渲染顺序一致 */
  flat: ModelEntry[];
  /** 密钥状态是否已取到 */
  keysReady: boolean;
  refresh: () => void;
  findByKey: (key: string) => ModelEntry | undefined;
}

export function modelKeyOf(m: Pick<ModelInfo, "provider" | "id">): string {
  return `${m.provider}/${m.id}`;
}

/** 上下文窗口缩写：1000000 → 1000k */
export function contextLabel(window: number | undefined): string | null {
  if (!window || !Number.isFinite(window) || window <= 0) return null;
  const k = Math.round(window / 1000);
  return `${k}k`;
}

/** 单价（每百万 token），缺失返回 null —— 不把「不知道」写成 0 */
export function priceLabel(cost: ModelInfo["cost"]): string | null {
  const input = cost?.input;
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  const output = cost?.output;
  return typeof output === "number" ? `$${input}/$${output}` : `$${input}`;
}

export function supportsImage(m: ModelInfo): boolean {
  return Array.isArray(m.input) && m.input.includes("image");
}

/** 模糊筛选：provider / id / name，忽略大小写 */
export function filterCatalog(groups: ModelGroup[], query: string): ModelGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((g) => ({
      ...g,
      models: g.models.filter(
        (e) =>
          e.model.provider.toLowerCase().includes(q) ||
          e.model.id.toLowerCase().includes(q) ||
          (e.model.name ?? "").toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.models.length > 0);
}

export function useModelCatalog(models: ModelInfo[]): ModelCatalog {
  const [keys, setKeys] = useState<Record<string, boolean> | null>(null);
  const [managed, setManaged] = useState<Set<string> | null>(null);
  const [credentials, setCredentials] = useState<Record<string, CredentialSource> | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const res = (await window.api.getModelRegistry()) as {
          keys?: Record<string, boolean>;
          credentials?: Record<string, CredentialSource>;
          registry?: { providers?: Record<string, unknown> };
        };
        setKeys(res?.keys ?? {});
        setManaged(new Set(Object.keys(res?.registry?.providers ?? {})));
        setCredentials(res?.credentials ?? {});
      } catch {
        setKeys({});
        setManaged(new Set());
        setCredentials({});
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 注册表改了（加 provider、存密钥）要重取；主进程里已有这个事件
  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener("omcp:models-changed", onChange);
    return () => window.removeEventListener("omcp:models-changed", onChange);
  }, [refresh]);

  const groups = useMemo<ModelGroup[]>(() => {
    const map = new Map<string, ModelEntry[]>();
    for (const model of models) {
      const list = map.get(model.provider) ?? [];
      list.push({ model, hasKey: keys ? keys[model.provider] === true : false });
      map.set(model.provider, list);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([provider, list]) => {
        // 凭据来源由主进程算（安全存储 / 官方环境变量 / pi 的 auth.json）；
        // 目录里没有这个 provider（例如扩展自带）时给 unknown，不妄下「缺密钥」的结论。
        const source: CredentialSource = credentials
          ? (credentials[provider] ?? "unknown")
          : "unknown";
        const hasKey = source === "none" ? false : source === "unknown" ? Boolean(keys?.[provider]) : true;
        return {
          provider,
          managed: managed ? managed.has(provider) : false,
          hasKey,
          credentialSource: source,
          models: list.sort((a, b) => (a.model.name ?? a.model.id).localeCompare(b.model.name ?? b.model.id)),
        };
      });
  }, [models, keys, managed, credentials]);

  const flat = useMemo(() => groups.flatMap((g) => g.models), [groups]);

  const findByKey = useCallback(
    (key: string) => flat.find((e) => modelKeyOf(e.model) === key),
    [flat],
  );

  return { groups, flat, keysReady: keys !== null, refresh, findByKey };
}
