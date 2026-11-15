import type { FileReadResult } from "@oh-my-coding-pi/shared";
import { parseDelimited } from "./delimited";

/** 2 MB 文本铺进 <pre> 会卡住渲染，显示层再截一次，和读取上限是两回事 */
const DISPLAY_CHARS = 200_000;

function extOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const cut = name.lastIndexOf(".");
  return cut > 0 ? name.slice(cut + 1).toLowerCase() : "";
}

export default function FilePreview({ result }: { result: FileReadResult }) {
  if (result.kind === "too-large" || result.kind === "binary") {
    return <div className="preview-note">{result.error || "无法预览"}</div>;
  }

  if (result.kind === "image") {
    return (
      <div className="preview-image">
        <img src={result.dataUrl} alt={result.path} />
      </div>
    );
  }

  const text = result.text ?? "";
  const ext = extOf(result.path);

  if (ext === "csv" || ext === "tsv") {
    const table = parseDelimited(text, ext === "tsv" ? "\t" : ",");
    if (table.rows.length === 0) return <div className="preview-note">空文件</div>;
    return (
      <div className="preview-table-wrap">
        <table className="preview-table">
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className={i === 0 ? "head" : ""}>
                {Array.from({ length: table.width }, (_, j) => (
                  <td key={j}>{row[j] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(table.truncatedRows || table.truncatedCols) && (
          <div className="dock-note">
            共 {table.totalRows} 行，只显示前 {table.rows.length} 行、前 {table.width} 列
          </div>
        )}
      </div>
    );
  }

  if (!text) return <div className="preview-note">空文件</div>;

  const clipped = text.length > DISPLAY_CHARS ? text.slice(0, DISPLAY_CHARS) : text;
  return (
    <>
      <pre className="preview-text">{clipped}</pre>
      {clipped.length < text.length && (
        <div className="dock-note">内容较长，只显示前 {DISPLAY_CHARS.toLocaleString()} 个字符</div>
      )}
    </>
  );
}
