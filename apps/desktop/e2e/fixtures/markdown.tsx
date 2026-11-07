import "../../src/renderer/src/i18n";
import { I18nextProvider } from "react-i18next";
import { i18n } from "../../src/shared/i18n";
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { Markdown } from "../../src/renderer/src/session/Markdown";
import { FinxProvider } from "../../src/renderer/src/store";
import "../../src/renderer/src/styles/tokens.css";
import "../../src/renderer/src/styles/app.css";
import "../../src/renderer/src/styles/files.css";
import "../../src/renderer/src/styles/markdown.css";

const initial = [
  "# FinxWork 内容展示", "", "中文正文采用品牌深海军蓝，链接使用可读性更好的[品牌蓝](https://example.com)。`#1F6BFF` 是品牌主色。", "",
  "## 分析过程", "", "1. 第一项", "", "2. 第二项", "",
  "> [!NOTE]", "> 这是提示块，背景保持中性色。", "",
  '| 指标 | 本期 | 上期 |', '|:---|---:|---:|', '| 收入 | 123,456.78 | 98,765.43 |', '| 单元格内竖线 | a\\|b | `code` |', "",
  "```typescript", 'const greeting = `hello', 'world`;', '/* 跨行注释', '   保留语法状态 */', 'export const amount = 123.45;', "```", "",
  "公式：\\(r = \\frac{V_1 - V_0}{V_0}\\)，金额 $100 和 $200 保持原文。", "",
  "$$", "E = mc^2", "$$", "",
  ':::details{title="展开计算说明"}', '这里是折叠内容。', ':::', '',
  '```mermaid', 'flowchart LR', ' A[读取数据] --> B{检查完整性}', ' B -->|通过| C[生成报告]', ' B -->|缺失| D[补充来源]', '```', '',
  '最后一段。',
].join('\n');
function Fixture() {
  const [text, setText] = useState(initial);
  const [streaming, setStreaming] = useState(false);
  Object.assign(window, { setMarkdown: (text: string, live = false) => { setText(text); setStreaming(live); }, fixtureText: initial });
  return <div className="cscroll markdown-chat" style={{ height: '100vh', overflow: 'auto' }}><div className="dbody"><div className="tr"><div className="am"><Markdown text={text} streaming={streaming} /></div></div></div></div>;
}
createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}><FinxProvider><Fixture /></FinxProvider></I18nextProvider>);
