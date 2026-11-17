import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

import { copyText } from "./clipboard";

/** 复制按钮复制的是源码，不是渲染后的 HTML */
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang || "code"}</span>
        <button onClick={() => void copyText(code)}>复制</button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * 助手回复的渲染。表格走 GFM，公式走 KaTeX。
 * 链接只显示、不导航：渲染进程跳转会顶掉整个界面，v1 还没接系统浏览器。
 */
function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children }) {
            const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
            const raw = String(children ?? "");
            const isBlock = Boolean(lang) || raw.includes("\n");
            if (!isBlock) return <code className="md-inline">{children}</code>;
            return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
          },
          a({ href, children }) {
            const target = href ?? "";
            const external = /^https?:\/\//i.test(target) || /^mailto:/i.test(target);
            return (
              <a
                href={href}
                title={
                  external
                    ? `在系统浏览器打开：${target}`
                    : href
                      ? `不打开（非 http/https 链接）：${target}`
                      : undefined
                }
                onClick={(e) => {
                  e.preventDefault();
                  if (!external) return;
                  void window.api.openExternal(target);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 文本不变就不重解析：长会话里历史消息不随每个 delta 重跑 GFM/KaTeX。 */
export default memo(MarkdownView);
