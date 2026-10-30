import type { ModelsListResult, ModelSummary, PermissionMode, ProviderSummary, SkillsListResult, SkillUse, ThinkingLevel } from "@finx/protocol";
import { skillMentions } from "../mentions.ts";
import type { TaskScript } from "./script.ts";
import { snake } from "./snake.ts";

// The demo: sessions in every state the window has to show, and the models
// finx would list. Paths sit next to the snake game's real one.

const min = 60_000;
const hour = 60 * min;
const day = 24 * hour;

export const root = snake.cwd.replace(/\/finxwork\/examples\/snake-game$/, "");
export const projects = {
  finxwork: `${root}/finxwork`,
  hermesh: `${root}/hermesh`,
  playground: `${root}/playground`,
};

export interface DemoTask {
  prompt: string;
  script: TaskScript;
  /** Interrupted after its turns. */
  interrupted?: boolean;
}

export interface DemoSession {
  id: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  permission_mode: PermissionMode;
  /** A title of its own (P3); without one the list shows the first message. */
  title?: string;
  archived?: boolean;
  /** When its first task started, before now. */
  ago: number;
  /** Tasks that ended before the demo starts. */
  history: DemoTask[];
  /** A task still going when the demo starts: its first `played` turns are done, the rest plays live. */
  live?: DemoTask & { played: number };
}

const gemini: TaskScript = {
  turns: [
    {
      think: "要加一个新的线协议适配器。先看现有的两个适配器怎么实现 WireApi，再对照 Gemini 的 streamGenerateContent 接口。",
      say: "先看一下现有适配器的结构。",
      tools: [
        { name: "bash", args: { command: "rg -n \"impl WireApi\" crates/finx-llm/src" }, output: "crates/finx-llm/src/api/openai_chat.rs:41:impl WireApi for OpenAiChat {\ncrates/finx-llm/src/api/anthropic.rs:38:impl WireApi for Anthropic {\ncrates/finx-llm/src/api/scripted.rs:22:impl WireApi for ScriptedApi {", ms: 300 },
        { name: "read", args: { path: `${projects.finxwork}/crates/finx-llm/src/api/anthropic.rs` }, output: "use crate::sse::SseStream;\nuse crate::stream::StreamEvent;\n…\npub struct Anthropic {\n    http: HttpClient,\n}\n…", ms: 200 },
      ],
    },
    {
      think: "Gemini 的流是 SSE，每个块是一个 GenerateContentResponse；工具调用在 functionCall 里，一次给全参数，没有增量。思考内容在 thought: true 的 part 里。",
      say: "结构清楚了。Gemini 的工具调用参数一次给全，所以适配器里要把 `functionCall` 直接转成 `ToolCallStart` 加一个完整的 `ToolCallArgs`。下面写适配器。",
      tools: [
        {
          name: "write",
          args: { path: `${projects.finxwork}/crates/finx-llm/src/api/gemini.rs`, content: "//! Google Gemini (streamGenerateContent, SSE).\n\nuse crate::sse::SseStream;\n…" },
          output: `Wrote 9412 bytes to ${projects.finxwork}/crates/finx-llm/src/api/gemini.rs`,
          ms: 250,
        },
        {
          name: "edit",
          args: { path: `${projects.finxwork}/crates/finx-llm/src/api/mod.rs`, edits: [{ old_text: "pub mod anthropic;", new_text: "pub mod anthropic;\npub mod gemini;" }] },
          output: `Edited ${projects.finxwork}/crates/finx-llm/src/api/mod.rs`,
          ms: 150,
        },
      ],
    },
    {
      think: "跑一下这个 crate 的测试，回放测试用录制好的 SSE。",
      say: "跑一遍 finx-llm 的测试。",
      tools: [
        {
          name: "bash",
          args: { command: "cargo test -p finx-llm" },
          progress: ["   Compiling finx-llm v0.1.0\n", "    Finished `test` profile [unoptimized + debuginfo] target(s) in 18.42s\n", "     Running unittests src/lib.rs\n", "running 64 tests\n", "test api::gemini::tests::streams_text ... ok\ntest api::gemini::tests::tool_call_in_one_chunk ... ok\n", "test result: ok. 64 passed; 0 failed\n"],
          output: "Exit code: 0\nDuration: 21.3s\nOutput:\nrunning 64 tests\n…\ntest result: ok. 64 passed; 0 failed; 0 ignored",
          ms: 9000,
        },
      ],
    },
    {
      say: "Gemini 适配器加好了，测试全部通过。\n\n**改动**\n\n- 新增 `crates/finx-llm/src/api/gemini.rs`：把 `streamGenerateContent` 的 SSE 块转成中立的流事件；`thought: true` 的部分作为思考内容，`functionCall` 一次性转成工具调用。\n- `api/mod.rs` 注册新模块。\n\n**还没做**\n\n1. 内置目录里还没有 Gemini 的厂商条目，需要在 `catalog/builtin.toml` 里补上。\n2. 回放测试只录了纯文本和单个工具调用两种流，多个并行调用的情况还没覆盖。\n\n```toml\n[[providers]]\nid = \"google\"\napi = \"gemini\"\nbase_url = \"https://generativelanguage.googleapis.com/v1beta\"\n```",
    },
  ],
};

const cleanup: TaskScript = {
  turns: [
    {
      think: "先看临时目录里有什么，占了多少空间。",
      say: "先看看 `~/.finx/tmp` 占了多少空间。",
      tools: [{ name: "bash", args: { command: "du -sh ~/.finx/tmp/* | sort -h | tail -5" }, output: "Exit code: 0\nDuration: 0.2s\nOutput:\n 12M\t/Users/demo/.finx/tmp/0193f0c2\n 48M\t/Users/demo/.finx/tmp/0193e1a7\n310M\t/Users/demo/.finx/tmp/0193d4b9", ms: 400 }],
    },
    {
      say: "这三个目录都属于已经结束的会话，里面是工具的完整输出，可以删掉，一共约 370 MB。",
      tools: [
        {
          name: "bash",
          args: { command: "rm -rf ~/.finx/tmp/0193f0c2 ~/.finx/tmp/0193e1a7 ~/.finx/tmp/0193d4b9" },
          output: "Exit code: 0\nDuration: 0.1s\nOutput:\n",
          ms: 300,
          approval: { summary: "rm -rf ~/.finx/tmp/0193f0c2 ~/.finx/tmp/0193e1a7 ~/.finx/tmp/0193d4b9", reason: "这条命令会删除文件，不在只读命令的范围内" },
        },
      ],
    },
    { say: "清理完了，释放了约 370 MB。以后可以在配置里设置 `tmp_retention_days`，让 finx 自动清理超过保留期的输出。" },
  ],
};

const review: TaskScript = {
  turns: [
    {
      think: "先通读方案文档，重点看阈值、保留最近消息的预算和失败处理。",
      say: "先读一下方案。",
      tools: [{ name: "read", args: { path: `${projects.finxwork}/docs/context-management.md` }, output: "# 上下文管理方案\n\n## 1. 目标\n…\n## 3. 阈值压缩\n达到窗口的一定比例时……", ms: 300 }],
    },
    { think: "方案的主体清楚了。接下来对照内核现在的实现，看 token 估算在哪里校准……" },
  ],
  fail: { kind: "rate_limited", message: "429 Too Many Requests: Rate limit reached for deepseek-flash in organization org-demo on tokens per min (TPM): Limit 1000000, Used 998211, Requested 31520. Please try again in 1.9s.", status: 429, retryable: true },
};

const readme: TaskScript = {
  turns: [
    {
      say: "先看现在的 README。",
      tools: [{ name: "read", args: { path: `${projects.hermesh}/README.md` }, output: "# Hermesh\n\nLet your agents hand work to Claude Code on your computer.\n…", ms: 200 }],
    },
    {
      say: "安装说明分散在三处，我把它们合并成一节，并按平台分开写。",
      tools: [{ name: "edit", args: { path: `${projects.hermesh}/README.md`, edits: [{ old_text: "## Install", new_text: "## 安装\n\n### macOS\n…" }] }, output: `Edited ${projects.hermesh}/README.md`, ms: 200 }],
    },
    { say: "改好了：安装说明合并成「安装」一节，分 macOS 和 Linux 两小节，命令都能直接复制运行。" },
  ],
};

const startup: TaskScript = {
  turns: [
    {
      think: "要找慢在哪里，先量。用 bench_startup.py 跑一遍，看分阶段的耗时。",
      say: "先量一下现在的启动时间。",
      tools: [{ name: "bash", args: { command: "python3 tools/bench/bench_startup.py --runs 20" }, output: "Exit code: 0\nDuration: 4.1s\nOutput:\nspawn → first request  p50 6.1 ms  p90 6.8 ms\nconfig load            p50 0.9 ms\nmodel registry         p50 1.2 ms\ntls roots              p50 1.3 ms", ms: 1500 }],
    },
    { say: "启动本身并不慢，从启动到发出第一个模型请求的中位数是 **6.1 ms**。耗时最多的三项是：\n\n| 阶段 | 中位数 |\n|---|---|\n| 系统信任库 | 1.3 ms |\n| 模型目录 | 1.2 ms |\n| 读取配置 | 0.9 ms |\n\n体感上的慢应该来自第一个请求的网络往返，而不是进程启动。" },
  ],
};

const timeout: TaskScript = {
  turns: [
    {
      think: "先看 bash 工具现在怎么处理超时：是杀进程组还是只杀子进程。",
      say: "看一下现在的超时处理。",
      tools: [{ name: "read", args: { path: `${projects.finxwork}/crates/finx-tools/src/builtin/bash.rs` }, output: "pub struct Bash;\n…\nlet status = tokio::time::timeout(limit, child.wait()).await;\n…", ms: 200 }],
    },
  ],
};

const migrate: TaskScript = {
  turns: [
    {
      say: "看一下会话日志现在的条目格式。",
      tools: [
        { name: "read", args: { path: `${projects.finxwork}/crates/finx-core/src/store/entry.rs` }, output: "#[serde(tag = \"type\", rename_all = \"snake_case\")]\npub enum Entry {\n    SystemPrompt { … },\n    Settings { … },\n    Message { … },\n    Task { … },\n}", ms: 200 },
        { name: "bash", args: { command: "cargo test -p finx-core store" }, output: "Exit code: 0\nDuration: 6.0s\nOutput:\ntest result: ok. 17 passed; 0 failed", ms: 1200 },
      ],
    },
    { say: "v2 只需要在 `session` 头里把 `version` 改成 2，并给 `message` 条目加上 `usage`。旧版本的日志在读取时补默认值即可，不需要迁移文件。" },
  ],
};

const reasoning: TaskScript = {
  turns: [
    { think: "用户想看推理模式的效果。用一道需要几步推导的题。", say: "推理模式下，模型会先输出思考过程，再给出答案。思考部分在界面上默认折叠，点开可以看全文。" },
  ],
};

export function demoSessions(): DemoSession[] {
  return [
    {
      id: "0193f6a2-5c1e-7b40-9d6a-1f2e3d4c5b6a",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "medium",
      permission_mode: "accept-edits",
      ago: 3 * min,
      history: [],
      live: { prompt: "给 finx-llm 加一个 Gemini 的线协议适配器，参照 anthropic.rs 的写法，加上回放测试。", script: gemini, played: 1 },
    },
    {
      id: "0193f5d0-2b7c-7e11-8a3f-6c5d4e3b2a19",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "low",
      permission_mode: "manual",
      title: "清理会话的临时输出",
      ago: 9 * min,
      history: [],
      live: { prompt: "~/.finx/tmp 越来越大了，帮我看看能不能清理一下。", script: cleanup, played: 1 },
    },
    {
      id: "0193f4b8-9e2d-7a65-b1c4-3d2e1f0a9b8c",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "high",
      permission_mode: "manual",
      title: "评审上下文压缩方案",
      ago: 40 * min,
      history: [{ prompt: "评审一下 docs/context-management.md 的压缩方案，重点看失败处理和多次压缩。", script: review }],
    },
    {
      id: "0193e2c4-7f1a-7d38-a2b6-5e4f3c2d1b0a",
      cwd: projects.hermesh,
      model: "anthropic/claude-sonnet-5-5",
      thinking: "off",
      permission_mode: "accept-edits",
      title: "整理 README 的安装说明",
      ago: 1 * day + 3 * hour,
      history: [{ prompt: "README 里的安装说明太散了，整理成一节，按平台分开。", script: readme }],
    },
    {
      id: "0193d9e7-3a5b-7c92-b4d1-8f7e6d5c4b3a",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "medium",
      permission_mode: "manual",
      title: "排查启动慢的原因",
      ago: 3 * day + 2 * hour,
      history: [{ prompt: "感觉 finx 启动有点慢，帮我查一下慢在哪里。", script: startup }],
    },
    {
      id: "0193d1f2-8c4e-7b13-9e5a-2d1c0b9a8f7e",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "medium",
      permission_mode: "manual",
      title: "重写 bash 工具的超时处理",
      ago: 4 * day + 5 * hour,
      history: [{ prompt: "bash 工具超时后，子进程有时还活着。改成超时杀整个进程组。", script: timeout, interrupted: true }],
    },
    {
      id: "0193b8a1-6d2f-7e47-8c3b-9a8f7e6d5c4b",
      cwd: projects.finxwork,
      model: "deepseek/deepseek-flash",
      thinking: "medium",
      permission_mode: "accept-edits",
      title: "会话日志格式升级到 v2",
      ago: 12 * day,
      history: [{ prompt: "会话日志要升级到 v2，看看需要改哪些地方，要不要迁移旧文件。", script: migrate }],
    },
    {
      id: "0193a4c7-1e9b-7f25-a6d8-4c3b2a1f0e9d",
      cwd: projects.playground,
      model: "deepseek/deepseek-pro",
      thinking: "max",
      permission_mode: "manual",
      title: "试用 DeepSeek 推理模式",
      archived: true,
      ago: 20 * day,
      history: [{ prompt: "试一下推理模式，看看思考过程怎么显示。", script: reasoning }],
    },
  ];
}

/** A reply to anything the owner writes in the demo: look around, then answer. */
export function replyScript(prompt: string): TaskScript {
  const topic = prompt.trim().split("\n")[0].slice(0, 60);
  return {
    turns: [
      {
        think: `用户的请求是「${topic}」。先了解项目的结构和约定，再决定从哪里入手。`,
        say: "好的，我先看一下项目的结构。",
        tools: [
          { name: "bash", args: { command: "ls -la" }, output: "Exit code: 0\nDuration: 0.0s\nOutput:\ntotal 168\ndrwxr-xr-x  12 demo  staff    384 Oct 28 23:20 .\n-rw-r--r--   1 demo  staff   1983 Oct 28 23:20 Cargo.toml\ndrwxr-xr-x   7 demo  staff    224 Oct 28 23:20 crates\ndrwxr-xr-x   3 demo  staff     96 Oct 28 23:20 docs", ms: 300 },
          { name: "read", args: { path: "README.md" }, output: "# finx\n\nA fast agent harness kernel.\n…", ms: 200 },
        ],
      },
      {
        say: "先把这个任务记到项目的 NOTES.md 里，接上内核之后可以从这里继续。",
        tools: [
          {
            name: "edit",
            args: { path: "NOTES.md", edits: [{ old_text: "## 待办\n", new_text: `## 待办\n\n- ${topic}\n` }] },
            output: "Edited NOTES.md",
            ms: 200,
            approval: { summary: "edit NOTES.md", reason: "要修改项目里的文件" },
          },
        ],
      },
      {
        think: "结构清楚了。这是演示环境，没有连接真实内核，给出一个说明即可。",
        say: `这是 **finxwork 的演示数据**：界面已经可以使用，但还没有连接 finx 内核，所以这里的回复是预先写好的。\n\n连接内核之后，你发出的「${topic}」会交给 finx 处理：\n\n1. 读取项目的指令文件和相关代码；\n2. 按审批模式执行工具调用，需要时在下方请你批准；\n3. 把结果写回这里。\n\n\`\`\`bash\n# 内核就绪后，桌面端会自动拉起常驻服务\nfinx serve --listen unix://\n\`\`\``,
      },
    ],
  };
}

/** What a steering message gets: an acknowledgement in the next turn. */
export function steerScript(text: string): TaskScript {
  return { turns: [{ say: `收到：「${text.trim().slice(0, 40)}」。我会在接下来的步骤里一并考虑。` }] };
}

/** The demo's skills: what `skills/list` reports and what `/skill:name` mentions can load. */
const demoSkillList: { name: string; description: string; hint?: string; scope: "project" | "user" }[] = [
  { name: "gen-report", description: "生成团队周报：读取本周的提交和任务，按固定格式写出 report.md", hint: "[周次]", scope: "user" },
  { name: "commit-style", description: "本仓库提交信息的格式要求，写提交信息时使用", scope: "project" },
  { name: "pdf-tools", description: "Extract text and tables from PDF files, and fill PDF forms", hint: "<file>", scope: "user" },
  { name: "release-notes", description: "按版本号生成发布说明", hint: "[version]", scope: "project" },
];

const skillPath = (s: (typeof demoSkillList)[number]) =>
  s.scope === "project" ? `/Users/demo/code/finxwork/.agents/skills/${s.name}/SKILL.md` : `/Users/demo/.agents/skills/${s.name}/SKILL.md`;

/** The demo's `skills/list`, for a session or a folder alike. */
export function demoSkills(): SkillsListResult {
  return {
    skills: demoSkillList.map((s) => ({
      name: s.name,
      description: s.description,
      path: skillPath(s),
      scope: s.scope,
      model_invocable: true,
      argument_hint: s.hint,
      state: "active",
    })),
    commands: [
      { name: "compact", description: "Summarize the conversation so far to free up the context window" },
      ...demoSkillList.map((s) => ({ name: `skill:${s.name}`, description: s.description, hint: s.hint, skill: skillPath(s) })),
    ],
    enabled: true,
    warnings: [],
  };
}

/** The demo skills a message's text mentions, as finx records them. */
export function demoSkillUses(text: string): SkillUse[] {
  const seen = new Set<string>();
  return skillMentions(
    text,
    demoSkillList.map((s) => s.name),
  ).flatMap((m) => {
    const skill = demoSkillList.find((s) => s.name === m.name)!;
    if (seen.has(skill.name)) return [];
    seen.add(skill.name);
    return [{ name: skill.name, path: skillPath(skill) }];
  });
}

const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "max"];

/** The demo's `models/list`: the shape finx sends, keys as if DeepSeek's came from the environment. */
export function demoModels(stored: ReadonlySet<string> = new Set()): ModelsListResult {
  const providers: ProviderSummary[] = [
    { id: "deepseek", name: "DeepSeek", auth: "api_key", credential: "env", credential_source: "DEEPSEEK_API_KEY", key_env: ["DEEPSEEK_API_KEY"] },
    { id: "anthropic", name: "Anthropic", auth: "api_key", credential: stored.has("anthropic") ? "stored" : "missing", key_env: ["ANTHROPIC_API_KEY"] },
    { id: "ollama", name: "Ollama", auth: "none", credential: "not_required" },
  ];
  const available = (provider: string) => providers.find((p) => p.id === provider)?.credential !== "missing";
  const model = (id: string, name: string, context_window: number, reasoning: boolean, images: boolean): ModelSummary => {
    const provider = id.split("/")[0];
    return { id, name, provider, context_window, reasoning, thinking_levels: reasoning ? levels : ["off"], images, available: available(provider) };
  };
  return {
    models: [
      model("deepseek/deepseek-flash", "DeepSeek Flash", 1_048_576, true, false),
      model("deepseek/deepseek-pro", "DeepSeek Pro", 1_048_576, true, false),
      model("anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, true, true),
      model("anthropic/claude-opus-5-5", "Claude Opus 5.5", 1_000_000, true, true),
      model("ollama/qwen3-coder", "Qwen3 Coder（本地）", 262_144, false, false),
    ],
    providers,
    defaults: { model: "deepseek/deepseek-flash", thinking: "medium", permission_mode: "manual" },
  };
}
