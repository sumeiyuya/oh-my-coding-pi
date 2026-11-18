import { useEffect, useRef, useState } from "react";
import type { UploadKind } from "@oh-my-coding-pi/shared";

/**
 * 输入框左侧的「添加内容」菜单（修改1）。
 * 只负责菜单与键盘可达性；选完文件后的落位由 App 处理。
 */
export default function UploadMenu({
  onPick,
  disabled,
}: {
  onPick: (kind: UploadKind) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (kind: UploadKind) => {
    setOpen(false);
    trigger.current?.focus();
    onPick(kind);
  };

  return (
    <div className="upload-attach" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="upload-trigger"
        aria-label="添加内容"
        aria-haspopup="menu"
        aria-expanded={open}
        title={disabled ? "先打开工作区" : "添加内容：上传文件 / 图片 / 数据"}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ＋
      </button>
      {open && (
        <div className="upload-menu" role="menu" aria-label="添加内容">
          <button type="button" role="menuitem" onClick={() => pick("file")}>
            <span className="upload-ico">文</span>
            <span>上传文件</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick("image")}>
            <span className="upload-ico">图</span>
            <span>上传图片</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick("data")}>
            <span className="upload-ico">表</span>
            <span>上传数据</span>
          </button>
        </div>
      )}
    </div>
  );
}
