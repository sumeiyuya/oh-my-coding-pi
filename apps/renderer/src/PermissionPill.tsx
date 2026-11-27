import { useCallback, useEffect, useRef, useState } from "react";
import type { PermissionMode, PermissionState } from "@oh-my-coding-pi/shared";

/**
 * 三档权限 pill（照 DAWN 的 src/ui/permission-pill.tsx）。
 *
 * - 放在顶栏模型选择左边：oh my coding pi 没有输入卡工具栏，位置换、语义不换；
 * - 有会话时改的是**这一段**（写 session meta），勾选「也作为以后新会话的默认」才改应用默认；
 * - 最底一行灰字写边界：不是沙箱；硬拒清单任何档都拒；run_code 里的代码不过这道门。
 */

const ORDER: PermissionMode[] = ["deny-risky", "ask-risky", "allow-all"];

export function permissionName(mode: PermissionMode): string {
  return mode === "allow-all" ? "完全访问权限" : mode === "ask-risky" ? "请求批准" : "自动拦截";
}

function shortName(mode: PermissionMode): string {
  return mode === "allow-all" ? "完全访问" : permissionName(mode);
}

function describe(mode: PermissionMode): string {
  if (mode === "allow-all") return "可不受限制地读写文件、执行命令、访问互联网；只拦硬拒清单";
  if (mode === "ask-risky") return "改原始数据、写到工作区外、删旧文件、装包、联网时始终询问你";
  return "检测到的风险操作直接拒绝，把理由回给模型让它改道";
}

function icon(mode: PermissionMode): string {
  return mode === "allow-all" ? "!" : mode === "ask-risky" ? "✋" : "▣";
}

export default function PermissionPill() {
  const [state, setState] = useState<PermissionState | null>(null);
  const [open, setOpen] = useState(false);
  /**
   * 「也作为以后新会话的默认」：按你的选择做成**常驻**——
   * 勾上就记住（localStorage），不会在切档后自动复位；
   * 界面上同时写清"当前默认是哪一档"，避免连默认被改了自己不知道。
   */
  const [asDefault, setAsDefaultState] = useState(() => {
    try {
      return localStorage.getItem("omcp.permissionAsDefault") === "1";
    } catch {
      return false;
    }
  });
  const setAsDefault = (value: boolean) => {
    setAsDefaultState(value);
    try {
      localStorage.setItem("omcp.permissionAsDefault", value ? "1" : "0");
    } catch {
      // 存不下也不影响本次会话
    }
  };
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setState((await window.api.getPermission()) as PermissionState);
    } catch {
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 修改六 · S4：另一处（权限面板 / 切会话 / 切工作区）改了档，这里同一帧跟上
  useEffect(() => window.api.onPermissionChanged((next) => setState(next as PermissionState)), []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const pick = async (mode: PermissionMode) => {
    const next = (await window.api.setPermission(mode, asDefault)) as PermissionState;
    setState(next);
    setOpen(false);
  };

  const current = state?.effective ?? "ask-risky";
  const followingDefault = state ? state.sessionOverride === null : true;

  return (
    <div className="perm-pill" ref={box} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        className="perm-pill-trigger"
        data-tier={current}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          void load();
        }}
        title={`工具权限：${permissionName(current)}`}
      >
        <span className="perm-pill-icon" aria-hidden="true">{icon(current)}</span>
        <span>{shortName(current)}</span>
        <span className="perm-pill-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="perm-pill-menu" role="menu" aria-label="工具权限">
          {ORDER.map((mode) => (
            <button
              key={mode}
              className="perm-pill-item"
              data-tier={mode}
              role="menuitemradio"
              aria-checked={mode === current}
              onClick={() => void pick(mode)}
            >
              <span className="perm-pill-item-icon" aria-hidden="true">{icon(mode)}</span>
              <span className="perm-pill-item-text">
                <span className="perm-pill-item-name">{permissionName(mode)}</span>
                <span className="perm-pill-item-desc">{describe(mode)}</span>
              </span>
              <span className="perm-pill-item-mark" aria-hidden="true">{mode === current ? "✓" : ""}</span>
            </button>
          ))}

          <label className="perm-pill-default">
            <input type="checkbox" checked={asDefault} onChange={(e) => setAsDefault(e.target.checked)} />
            <span>也作为以后新会话的默认</span>
            <span className="perm-pill-hint">（当前默认：{permissionName(state?.default ?? "ask-risky")}）</span>
            {followingDefault && <span className="perm-pill-hint"> · 这一段跟着默认</span>}
          </label>

          <p className="perm-pill-note">
            这是一道工具门，不是沙箱。硬拒清单（sudo、删到主目录 / 系统目录、带凭据出网、强推）任何档都拒；
            run_code 里的代码不过这道门。
          </p>
        </div>
      )}
    </div>
  );
}
