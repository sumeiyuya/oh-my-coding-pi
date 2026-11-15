from pathlib import Path

base = Path(__file__).resolve().parent.parent / ".." / "results" / "reports"
src_path = base / "P1详细执行计划_交互版.html"
dst_path = base / "P2详细执行计划_交互版.html"
s = src_path.read_text(encoding="utf-8")


def repl_block(text, start_marker, end_marker, new):
    i = text.index(start_marker)
    j = text.index(end_marker, i)
    return text[:i] + new + text[j:]


phases = """const PHASES = [
    {id:"p20", name:"P2.0 工作区", week:"第 1 周", goal:"工作区选择、.omcp 初始化、会话迁移", color:"#6366f1"},
    {id:"p21", name:"P2.1 内核", week:"第 1–2 周", goal:"sidecar、主进程 broker、run_code", color:"#3b82f6"},
    {id:"p22", name:"P2.2 笔记本", week:"第 2–3 周", goal:"cell、流式、图片、中断/重启", color:"#0ea5e9"},
    {id:"p23", name:"P2.3 R 内核", week:"第 3–4 周", goal:"IRkernel、R 图、语言切换", color:"#8b5cf6"},
    {id:"p24", name:"P2.4 验收", week:"第 4–5 周", goal:"A1、图片落盘、稳定性、安装回归", color:"#10b981"}
  ];"""
s = repl_block(s, "const PHASES = [", "\n  const STATUS", phases)

tasks = r"""const DEFAULT_TASKS = [
    T("workspace","p20",1,"工作区选择与最近列表","目录选择器、最近工作区、路径绝对化","打开目录后显示路径；最近列表可切换",8,false,true),
    T("science","p20",1,"`.omcp` 初始化","创建 sessions/logs/notebooks/figures、AGENTS 模板、data/analysis/results 骨架","新工作区一键初始化；不覆盖已有文件",8,false,true),
    T("migrate","p20",1,"会话迁移","把 userData/sessions 复制到 `<ws>/.omcp/sessions`，保留旧目录","旧会话可见、可恢复；不删除旧数据",8,false,true),
    T("wssettings","p20",1,"工作区设置与信任","每工作区 settings、信任状态、切工作区重载 pi","切换后 cwd/会话/设置正确",8,false,false),

    T("sidecar","p21",1,"移植 sidecar.py","从 S5 移到 packages/kernel-sidecar；协议 start/execute/interrupt/restart/shutdown","Python 内核可启停、流式、图片",12,false,true),
    T("broker","p21",2,"主进程 KernelService + broker","main 持有 sidecar；localhost HTTP + token；扩展与 UI 共用同一内核","chat 与 notebook 执行同一内核，变量互通",16,true,true),
    T("env","p21",2,"环境探测与路径","工作区 .venv → 系统 Python；Rscript 路径；设置页可覆盖","找不到解释器时明确报错",8,false,false),
    T("runcode","p21",2,"run_code 扩展","science-ext 注册工具；OMCP_KERNEL_URL/TOKEN；onUpdate 流式","模型能连续调用，变量保留",12,true,true),

    T("cells","p22",2,"笔记本 cell 模型与持久化","cell 列表、语言、状态；存 `.omcp/notebooks/*.json`","刷新/重启后 cell 不丢",8,false,false),
    T("editor","p22",3,"编辑器与执行","代码编辑、运行、流式输出、执行中禁用","点击运行能看到逐行输出",16,false,true),
    T("outputs","p22",3,"图片与错误展示","PNG 内嵌、traceback、输出截断","图能显示；错误可读",8,false,false),
    T("kernelctl","p22",3,"中断/重启/变量","interrupt、restart、变量列表（who）","长循环可中断；重启清变量并提示",8,true,true),

    T("irkernel","p23",3,"IRkernel 注册","`IRkernel::installspec()`；kernelspec 名为 ir","`jupyter kernelspec list` 有 ir",4,false,false),
    T("rsidecar","p23",4,"sidecar R 支持","lang=r、kernel_name=ir、绘图设备","R 能执行并出图",8,false,true),
    T("rui","p23",4,"R 语言切换","笔记本语言切换；R cell 执行；R 图显示","Python/R 可分别运行，互不串变量",8,false,false),
    T("rdocs","p23",4,"R 排错文档","kernelspec、编码、字体、绘图设备常见问题","文档可照做",4,false,false),

    T("a1","p24",4,"A1 验收","读 sandbox demo.csv → 描述统计 → 箱线图","对话/笔记本可完成 A1",8,true,true),
    T("savepolicy","p24",4,"图片/表格落盘","图存 figures/、表存 results/tables/；时间戳不覆盖","路径正确，旧文件不删",8,false,true),
    T("stability","p24",5,"稳定性与恢复","50 次 execute、中断、重启、杀 pi 恢复","0 失败；变量/会话符合预期",8,true,true),
    T("install","p24",5,"安装回归","重新打包，非管理员安装，安装态跑 A1","安装包可运行，卸载干净",8,true,true),
    T("buffer","p24",5,"缓冲与修 bug","预留缓冲","无 P0/P1 缺陷",4,false,false)
  ];"""
s = repl_block(s, "const DEFAULT_TASKS = [", "\n  const MILESTONES", tasks)

milestones = """const MILESTONES = [
    {id:"m1", name:"M1 工作区可用", week:"第 1 周末", criteria:"打开目录、.omcp 初始化、旧会话可见", tasks:["workspace","science","migrate","wssettings"]},
    {id:"m2", name:"M2 内核与 run_code", week:"第 2 周末", criteria:"Python 内核、broker、run_code 变量保留", tasks:["sidecar","broker","env","runcode"]},
    {id:"m3", name:"M3 笔记本可用", week:"第 3 周末", criteria:"cell、流式、图、中断/重启", tasks:["cells","editor","outputs","kernelctl"]},
    {id:"m4", name:"M4 R + A1 + 安装", week:"第 5 周末", criteria:"R 图、A1、稳定性、安装回归", tasks:["irkernel","rsidecar","rui","rdocs","a1","savepolicy","stability","install","buffer"]}
  ];"""
s = repl_block(s, "const MILESTONES = [", "\n  const ACCEPTANCE", milestones)

acceptance = """const ACCEPTANCE = [
    {id:"ap21", title:"工作区", detail:"打开目录 → .omcp 创建 → 会话落在工作区"},
    {id:"ap22", title:"run_code", detail:"chat 连续调用，变量保留"},
    {id:"ap23", title:"笔记本图片", detail:"cell 执行 → 图显示 → figures/ 落盘"},
    {id:"ap24", title:"R", detail:"R cell 执行并出图"},
    {id:"ap25", title:"内核控制", detail:"中断 <3s；重启清变量；50 次稳定"},
    {id:"ap26", title:"A1", detail:"csv → 描述统计 → 箱线图 → 表"},
    {id:"ap27", title:"安装", detail:"非管理员安装，安装态跑 A1"}
  ];"""
s = repl_block(s, "const ACCEPTANCE = [", "\n  const DEFAULT_RISKS", acceptance)

risks = """const DEFAULT_RISKS = [
    {id:"r1", risk:"内核共享架构（扩展 vs 主进程）", prob:"高", impact:"高", mitigation:"主进程持有 sidecar；localhost HTTP + token；扩展只做客户端", trigger:"chat 与 notebook 变量不通", status:"监控中"},
    {id:"r2", risk:"R kernelspec/绘图设备", prob:"高", impact:"中", mitigation:"P0 已确认 IRkernel 安装；P2 先跑通 installspec + png", trigger:"R cell 无输出/无图", status:"监控中"},
    {id:"r3", risk:"工作区迁移丢会话", prob:"中", impact:"高", mitigation:"复制不移动；旧目录保留；迁移前统计数量", trigger:"旧会话在新目录缺失", status:"监控中"},
    {id:"r4", risk:"sidecar 打包/Python 路径", prob:"中", impact:"高", mitigation:"sidecar 进 extraResources；Python 用系统/venv，可配置", trigger:"安装态找不到 sidecar", status:"监控中"},
    {id:"r5", risk:"localhost broker 安全", prob:"中", impact:"中", mitigation:"随机端口 + 一次性 token；只绑 127.0.0.1", trigger:"未授权请求可执行代码", status:"监控中"},
    {id:"r6", risk:"图片过大/上下文成本", prob:"中", impact:"中", mitigation:"图片压缩/尺寸上限；只回传必要图", trigger:"单图 >1MB 或上下文暴涨", status:"监控中"},
    {id:"r7", risk:"范围蔓延到统计/ML", prob:"高", impact:"高", mitigation:"P2 只做内核/笔记本/A1；统计建模留到后续", trigger:"出现「顺便加个模型」", status:"监控中"},
    {id:"r8", risk:"Windows 路径/空格/编码", prob:"高", impact:"中", mitigation:"参数逐项传；UTF-8；sidecar 输出统一编码", trigger:"路径截断/乱码", status:"监控中"}
  ];"""
s = repl_block(s, "const DEFAULT_RISKS = [", "\n  const DEFAULT_DECISIONS", risks)

decisions = """const DEFAULT_DECISIONS = [
    {id:"d1", date:"2026-11-11", title:"内核归属", decision:"主进程持有 sidecar；扩展与 UI 通过 localhost broker 共用同一内核。", status:"已定"},
    {id:"d2", date:"2026-11-11", title:"内核粒度", decision:"每个工作区每种语言一个内核（Python/R 分开）。", status:"已定"},
    {id:"d3", date:"2026-11-11", title:"会话迁移", decision:"复制 userData/sessions 到 <ws>/.omcp/sessions，保留旧目录。", status:"已定"},
    {id:"d4", date:"2026-11-11", title:"sidecar 分发", decision:"sidecar.py 进 extraResources；Python 用系统/venv，不打包解释器。", status:"已定"},
    {id:"d5", date:"2026-11-11", title:"笔记本持久化", decision:"cell 存 .omcp/notebooks/*.json；图存 figures/。", status:"已定"},
    {id:"d6", date:"2026-11-11", title:"A1 数据", decision:"用 sandbox/data/raw/demo.csv，不碰真实论文数据。", status:"已定"}
  ];"""
s = repl_block(s, "const DEFAULT_DECISIONS = [", "\n  const DEFAULT_STATE", decisions)

s = s.replace('KEY = "omcp-p1-v1"', 'KEY = "omcp-p2-v1"')
s = s.replace("<title>P1 详细执行计划 · 交互看板</title>", "<title>P2 详细执行计划 · 交互看板</title>")
s = s.replace("<h1>P1 详细执行计划</h1>", "<h1>P2 详细执行计划</h1>")
s = s.replace("<p>对话 + 会话 · 按契约进入实现 · 不含笔记本（P2）</p>", "<p>工作区 + 内核共享 + 笔记本 + R + A1 验收</p>")
s = s.replace("for(let w=1;w<=4;w++){", "for(let w=1;w<=5;w++){")
s = s.replace("Math.min(4,Math.floor(n/5)+1)", "Math.min(5,Math.floor(n/5)+1)")
s = s.replace("P1 已完成 · GO", "P1 已完成 · 19/19")
s = s.replace("73/73 步 · 80/80 小时 · 6/6 门槛", "19/19 任务 · 160/160 小时 · P1 验收通过")
s = s.replace("P0详细执行计划_交互版.html", "P1详细执行计划_交互版.html")
s = s.replace("P1 执行记录", "P2 执行记录")
s = s.replace("p1-plan-", "p2-plan-")
s = s.replace('<span className="tag">P1.3</span>', '<span className="tag">P2</span>')

dst_path.write_text(s, encoding="utf-8")
print("wrote", dst_path, len(s))
