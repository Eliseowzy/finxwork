import type { Avatar } from "@finx/protocol";
import type { TaskScript, ToolScript } from "./script.ts";

// Bot mode in the mock (docs/kernel/bot-design.md): the demo's bots and what
// they answer. A bot talks only through send_to_user: a quick question gets
// one message, work that takes time goes to a background helper whose report
// the bot relays, and an action that needs the owner asks first.

/** A message to the owner; the last of a turn ends it. */
export function send(text: string, end = false): ToolScript {
  return { name: "send_to_user", args: end ? { text, end_turn: true } : { text }, output: "Sent.", ms: 60 };
}

/** Files and images on their own. */
export function attach(paths: string[], end = false, text?: string): ToolScript {
  const files = paths.map((name) => {
    const path = `/Users/demo/.finx/bots/analyst/files/${name}`;
    const chart = demoCharts[name];
    return chart ? { path, size: 128_000, image: true, width: chart.width, height: chart.height } : { path, size: name.endsWith(".pdf") ? 2_400_000 : 186_000 };
  });
  const args = { type: "attachment", files: paths.map((path) => ({ path })), ...(text ? { text } : {}), ...(end ? { end_turn: true } : {}) };
  return { name: "send_to_user", args, output: "Sent.", details: { files, ...(text ? { text } : {}) }, ms: 60 };
}

/** A question with answers to tap. */
export function ask(text: string, options: string[]): ToolScript {
  return { name: "send_to_user", args: { type: "question", text, options: options.map((label) => ({ label })) }, output: "Sent.", ms: 60 };
}

/** A small chart with a white ground, as a bot's would be. */
function chart(title: string, points: number[]): { width: number; height: number; svg: string } {
  const width = 960;
  const height = 600;
  const line = points.map((v, i) => `${80 + (i * 800) / (points.length - 1)},${500 - v * 340}`).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/><text x="40" y="60" font-family="sans-serif" font-size="28" font-weight="600" fill="#0b0b0b">${title}</text><line x1="80" x2="880" y1="500" y2="500" stroke="#e7e6e2" stroke-width="2"/><polyline points="${line}" fill="none" stroke="#2a78d6" stroke-width="4" stroke-linejoin="round"/></svg>`;
  return { width, height, svg };
}

const demoCharts: Record<string, ReturnType<typeof chart>> = {
  "margin.png": chart("Gross margin", [0.78, 0.82, 0.74, 0.68, 0.66, 0.6, 0.28]),
  "materials.png": chart("Materials cost", [0.2, 0.22, 0.26, 0.3, 0.38, 0.48, 0.82]),
};

/** The picture at a path of the demo's, as files/read gives it. */
export function demoImage(path: string): { mime_type: string; data: string } | null {
  const shown = demoCharts[path.split("/").at(-1) ?? ""];
  return shown ? { mime_type: "image/svg+xml", data: btoa(shown.svg) } : null;
}

export interface DemoBot {
  name: string;
  avatar: Avatar;
  default?: boolean;
  pinned?: boolean;
  /** How long ago its conversation began, and what was said. */
  ago: number;
  history: { prompt: string; script: TaskScript }[];
  /** A task under way when the demo starts, up to its first turn (an approval, say). */
  live?: { prompt: string; script: TaskScript };
  unread?: number;
}

const hour = 3_600_000;

export function demoBots(): DemoBot[] {
  return [
    {
      name: "FinxBot",
      avatar: { kind: "mark" },
      default: true,
      ago: 20 * hour,
      history: [{ prompt: "早上好", script: { turns: [{ tools: [send("早！今天有什么要我做的？随时说，一次说几件也行。", true)] }] } }],
    },
    {
      name: "研究员",
      avatar: { kind: "char", shape: "round", hue: "slate" },
      ago: 26 * hour,
      history: [
        {
          prompt: "对比一下常见的三种自动更新方案",
          script: {
            turns: [
              { tools: [send("在查了，查完告诉你。")] },
              { think: "先找三种方案各自的文档。", tools: [{ name: "bash", args: { command: "curl -s https://example.com/updates" }, output: "Exit code: 0", ms: 900 }] },
              { tools: [send(research("自动更新方案").told, true)] },
            ],
          },
        },
      ],
    },
    {
      name: "运维",
      avatar: { kind: "char", shape: "box", hue: "teal" },
      ago: 2 * hour,
      history: [],
      live: { prompt: "nginx 挂了，帮我看看", script: restartScript() },
    },
    {
      name: "写作助手",
      avatar: { kind: "mono", hue: "clay" },
      ago: 5 * hour,
      unread: 2,
      history: [
        {
          prompt: "帮我把这句开场白改得口语一点：「本次会议旨在对第三季度的经营情况进行全面回顾。」",
          script: { turns: [{ tools: [send("改好了：「今天咱们一起回顾一下第三季度做得怎么样。」"), send("要更正式一点的话，也可以说「今天我们回顾第三季度的经营情况」。", true)] }] },
        },
      ],
    },
    {
      name: "分析师",
      avatar: { kind: "char", shape: "round", hue: "teal" },
      ago: 8 * hour,
      history: [
        {
          prompt: "把三季度的毛利率分析一下，出张趋势图，再整理一份报告给我。",
          script: {
            turns: [
              { tools: [send("在拉三季度的数据，做完发你。")] },
              { tools: [{ name: "bash", args: { command: "python make_charts.py" }, output: "Exit code: 0", ms: 900 }] },
              {
                tools: [
                  attach(["margin.png", "materials.png", "三季度毛利率分析.pdf", "毛利率明细.xlsx"], false, "三季度毛利率 38.6%，比二季度低 2.6 个百分点。主要是原材料涨价，销售费用基本没变。"),
                  ask("报告要发给谁？", ["先留给我看", "发给财务组", "发给全部门"]),
                ],
              },
            ],
          },
        },
      ],
    },
    { name: "记账", avatar: { kind: "char", shape: "egg", hue: "ochre" }, ago: 50 * hour, history: [] },
  ];
}

/** What a helper writes for a request, and what the bot then tells the owner. */
function research(topic: string): { helper: TaskScript; told: string } {
  return {
    helper: {
      turns: [
        { tools: [{ name: "bash", args: { command: `curl -s https://example.com/search?q=${encodeURIComponent(topic)}` }, output: "Exit code: 0\nOutput:\n…", progress: ["Fetching…", "Parsing results…"], ms: 2600 }] },
        { tools: [{ name: "read", args: { path: "notes.md" }, output: "…", ms: 900 }] },
        { say: `关于「${topic}」：找到三条主要结论，已整理成表。` },
      ],
    },
    told: `「${topic}」查好了：\n\n| 方案 | 优点 | 代价 |\n|---|---|---|\n| 甲 | 简单 | 更新慢 |\n| 乙 | 增量 | 实现复杂 |\n| 丙 | 无感知 | 需要签名 |\n\n要我细说哪一种？`,
  };
}

/** Restarting a service: the bot says why and asks, then reports. */
function restartScript(): TaskScript {
  return {
    turns: [
      {
        tools: [
          { name: "bash", args: { command: "journalctl -u nginx --since '10 min ago' | tail -5" }, output: "nginx.service: Main process exited, code=killed, status=9/KILL", ms: 700 },
        ],
      },
      {
        tools: [
          send("看了日志：nginx 的主进程被系统杀掉了，可能是内存不够。要重启 nginx，你确认一下。"),
          { name: "bash", args: { command: "sudo systemctl restart nginx" }, output: "Exit code: 0", ms: 900, approval: { summary: "sudo systemctl restart nginx" } },
        ],
      },
      { tools: [send("重启好了，nginx 已经在跑。我会留意一下内存，再挂的话告诉你。", true)] },
    ],
  };
}

/** What a bot answers to one message. */
export function botScript(text: string): TaskScript {
  const t = text.trim();
  if (/诗/.test(t)) {
    const season = t.match(/[春夏秋冬]/)?.[0] ?? "春";
    return { turns: [{ tools: [send(poem(season), true)] }] };
  }
  if (/提醒|闹钟|定时/.test(t)) return { turns: [{ tools: [send("定时提醒我现在还做不到，等之后的版本。到时候你直接跟我说就行。", true)] }] };
  if (/nginx|重启|restart/i.test(t)) return restartScript();
  if (/查|调研|对比|整理|统计|列出|分析|找|研究|汇总/.test(t)) {
    const topic = t.replace(/^(帮我|请|麻烦)?/, "").slice(0, 24);
    const { helper } = research(topic);
    const spawn: ToolScript = { name: "spawn_agent", args: { description: topic.slice(0, 20), task: t }, output: "started", ms: 80, agent: helper };
    return { turns: [{ tools: [spawn, send("在查了，查完告诉你。", true)] }] };
  }
  if (/^(你好|早|嗨|hi|hello|在吗)/i.test(t)) return { turns: [{ tools: [send("在的！有什么要我做的？", true)] }] };
  return { turns: [{ think: "想想怎么回答。", tools: [send(`好的。「${t.slice(0, 30)}」这件事，我的看法是先把目标说清楚，再分两步做。要我直接开始吗？`, true)] }] };
}

/** What the bot says when its helpers' reports come in. */
export function relayScript(reports: string[]): TaskScript {
  const topic = reports[0]?.match(/关于「(.+?)」/)?.[1] ?? "那件事";
  return { turns: [{ tools: [send(research(topic).told, true)] }] };
}

function poem(season: string): string {
  const lines: Record<string, string> = {
    春: "**春**\n\n风把柳枝梳成绿色，\n燕子衔来半句诗。\n雨落在屋檐上，\n替花数着开的日子。",
    夏: "**夏**\n\n蝉声铺满午后，\n冰西瓜裂开一道光。\n晚风推开纱窗，\n星星在稻田里纳凉。",
    秋: "**秋**\n\n桂花把香气挂在门口，\n银杏落成一地金箔。\n雁字写过天空，\n收成在仓里慢慢变暖。",
    冬: "**冬**\n\n雪把城市调成静音，\n炉火读着旧书。\n窗上的霜花开了，\n等一封春天的回信。",
  };
  return lines[season] ?? lines.春;
}
