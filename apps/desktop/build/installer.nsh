; oh-my-coding-pi 安装/卸载加固
;
; 背景：P3 验收发现 /S 卸载退出码 0、但 resources/app.asar 仍被占用删不掉。
; 根因是另一个进程持有该文件（实测是编辑器/索引类工具），卸载器本身没问题。
;
; 策略：
;   1) 卸载前先关掉本应用，避免自己占用；
;   2) 对 app.asar 重试删除；
;   3) 仍删不掉 → 写一个清理脚本，登记 HKCU RunOnce 在下次登录时清理（不需要管理员）。
;      清理脚本自带守卫：目录里没有 app.asar，或又出现了卸载器（说明重装过），就什么都不做；
;   4) 重新安装时撤销 RunOnce，避免误删新装的目录。

!macro customInit
  ; 内置 pi 的依赖路径较深：安装路径过长会在解包时出错，在写任何注册表之前拦住
  StrLen $0 "$INSTDIR"
  ${If} $0 > 200
    ${If} ${Silent}
      SetErrorLevel 2
      Abort
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "安装路径过长（$0 个字符）。请换一个更短的目录，例如 D:\oh my coding pi 。Install path too long ($0 chars); choose a shorter folder such as D:\oh my coding pi."
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "oh my coding piUninstallCleanup"
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /f /im "${APP_EXECUTABLE_FILENAME}"'
  Sleep 600

  ; 重试两轮：短暂占用通常能解开
  Delete "$INSTDIR\resources\app.asar"
  Sleep 500
  Delete "$INSTDIR\resources\app.asar"

  IfFileExists "$INSTDIR\resources\app.asar" 0 skipCleanup

  StrCpy $R9 "$TEMP\oh-my-coding-pi-cleanup.cmd"
  FileOpen $0 "$R9" w
  FileWrite $0 '@echo off$\r$\n'
  FileWrite $0 'if not exist "$INSTDIR\resources\app.asar" exit /b 0$\r$\n'
  FileWrite $0 'if exist "$INSTDIR\Uninstall oh my coding pi.exe" exit /b 0$\r$\n'
  FileWrite $0 'rmdir /s /q "$INSTDIR"$\r$\n'
  FileWrite $0 'del /f /q "%~f0"$\r$\n'
  FileClose $0

  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "oh my coding piUninstallCleanup" '"$TEMP\oh-my-coding-pi-cleanup.cmd"'
  DetailPrint "app.asar 被占用，已登记下次登录清理：$INSTDIR"

  skipCleanup:
!macroend
