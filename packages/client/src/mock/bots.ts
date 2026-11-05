import type { Avatar } from "@finx/protocol";
import type { TaskScript, ToolScript } from "./script.ts";

// Bot mode in the mock (docs/kernel/bot-design.md): the demo's bots and what
// they answer. A bot talks only through send_to_user: a quick question gets
// one message, work that takes time goes to a sub-agent whose report
// the bot relays, and an action that needs the owner asks first.

/** A message to the owner; the last of a turn ends it. */
export function send(text: string, end = false): ToolScript {
  return { name: "send_to_user", args: end ? { text, end_turn: true } : { text }, output: "Sent.", ms: 60 };
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
  routines?: DemoRoutine[];
}

/** A routine in the demo, and how its runs went. */
export interface DemoRoutine {
  name: string;
  when: string;
  schedule: string;
  prompt: string;
  paused?: boolean;
  /** What each run did, newest first; hours before now. */
  runs: { hoursAgo: number; outcome: "reported" | "quiet" | "failed" | "skipped"; text?: string; delivered?: boolean }[];
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
      routines: [
        {
          name: "每日盘前简报",
          when: "工作日早上 8 点",
          schedule: "0 8 * * 1-5",
          prompt: "看隔夜的美股和新闻，挑三件今天开盘前值得知道的事，每件一句话。没有值得说的就不用打扰。",
          runs: [
            { hoursAgo: 3, outcome: "reported", text: "隔夜美股小幅收高；半导体领涨；今晚有非农数据。", delivered: true },
            { hoursAgo: 27, outcome: "quiet", text: "隔夜没有大消息。" },
            { hoursAgo: 51, outcome: "failed", text: "Error (network): 读不到新闻站点。" },
          ],
        },
        {
          name: "特斯拉跌破 300 提醒",
          when: "工作日每小时（美股交易时段）",
          schedule: "CRON_TZ=America/New_York 0 10-16 * * 1-5",
          prompt: "查特斯拉现在的股价。低于 300 美元就告诉我，并说这个提醒结束了；否则不用说。查不到就说查不到。",
          paused: true,
          runs: [
            { hoursAgo: 12, outcome: "quiet", text: "TSLA 412.5 美元，没有跌破。" },
            { hoursAgo: 13, outcome: "quiet", text: "TSLA 410.2 美元，没有跌破。" },
            { hoursAgo: 14, outcome: "quiet", text: "TSLA 408.9 美元，没有跌破。" },
            { hoursAgo: 15, outcome: "skipped" },
          ],
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
    { name: "记账", avatar: { kind: "char", shape: "egg", hue: "ochre" }, ago: 50 * hour, history: [] },
  ];
}

/** What a sub-agent writes for a request, and what the bot then tells the owner. */
function research(topic: string): { agent: TaskScript; told: string } {
  return {
    agent: {
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

/** A reminder asked for in the chat: the bot makes the routine, and says when it first runs. */
function routineScript(asked: string): TaskScript {
  const when = "明天早上 9 点";
  const name = asked.replace(/^(帮我|请|麻烦)?(定时)?(提醒我?)?/, "").slice(0, 12) || "提醒";
  const save: ToolScript = {
    name: "manage_routine",
    args: { action: "create", name, prompt: `提醒用户：${asked}`, schedule: "in 1d", when },
    output: `Saved routine "${name}" (id r_mock).`,
    ms: 80,
    routine: { name, when, schedule: "in 1d", prompt: `提醒用户：${asked}` },
  };
  return { turns: [{ tools: [save] }, { tools: [send(`记下了，${when}提醒你。到时候 Mac 要醒着。`, true)] }] };
}

/** What a bot answers to one message. */
export function botScript(text: string): TaskScript {
  const t = text.trim();
  if (/诗/.test(t)) {
    const season = t.match(/[春夏秋冬]/)?.[0] ?? "春";
    return { turns: [{ tools: [send(poem(season), true)] }] };
  }
  if (/提醒|闹钟|定时/.test(t)) return routineScript(t);
  if (/nginx|重启|restart/i.test(t)) return restartScript();
  if (/查|调研|对比|整理|统计|列出|分析|找|研究|汇总/.test(t)) {
    const topic = t.replace(/^(帮我|请|麻烦)?/, "").slice(0, 24);
    const { agent } = research(topic);
    const spawn: ToolScript = { name: "spawn_agent", args: { description: topic.slice(0, 20), task: t }, output: "started", ms: 80, agent: agent };
    return { turns: [{ tools: [spawn, send("在查了，查完告诉你。", true)] }] };
  }
  if (/^(你好|早|嗨|hi|hello|在吗)/i.test(t)) return { turns: [{ tools: [send("在的！有什么要我做的？", true)] }] };
  return { turns: [{ think: "想想怎么回答。", tools: [send(`好的。「${t.slice(0, 30)}」这件事，我的看法是先把目标说清楚，再分两步做。要我直接开始吗？`, true)] }] };
}

/** What the bot says when its sub-agents' reports come in. */
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
