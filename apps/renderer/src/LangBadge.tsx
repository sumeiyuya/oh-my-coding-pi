/**
 * Python / R 的语言徽标（方案 B：字母）。
 * 只做标识：17px 小徽标，鼠标悬停给全称；不承担跳转或切换。
 */

export type CodeLang = "python" | "r";

export default function LangBadge({ lang }: { lang: CodeLang }) {
  const label = lang === "r" ? "R" : "Py";
  const title = lang === "r" ? "R 内核" : "Python 内核";
  return (
    <span className={`lang-badge ${lang}`} title={title} aria-label={title}>
      {label}
    </span>
  );
}
