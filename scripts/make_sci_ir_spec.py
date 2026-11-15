#!/usr/bin/env python
"""[旧方案] 由 ir 生成 sci-ir kernelspec。

2026-11-14 起不再需要：在「设置 → 内核」里填 R 解释器路径后，
应用会自己生成 omcp-r 的 kernelspec（argv 用同目录 Rterm.exe）并按它启动。
保留这个脚本只为兼容“路径留空、回退到 sci-ir”的老用法。
"""
import json
import os
from pathlib import Path

base = Path(os.environ["APPDATA"]) / "jupyter" / "kernels"
src = base / "ir" / "kernel.json"
dst_dir = base / "sci-ir"
dst_dir.mkdir(parents=True, exist_ok=True)
data = json.loads(src.read_text(encoding="utf-8"))
data["argv"][0] = "D:/Software_study/R-4.5.2/bin/x64/Rterm.exe"
data["display_name"] = "R (oh-my-coding-pi)"
(dst_dir / "kernel.json").write_text(
    json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)
print(dst_dir / "kernel.json")
