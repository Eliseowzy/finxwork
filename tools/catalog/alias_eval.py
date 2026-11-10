"""How gateway model ids resolve to the public catalog, stage by stage
(docs/kernel/custom-endpoint-design.md §6.6 and appendix A).

Fetch the data into one directory first:

    curl -o DATA/modelsdev.json https://models.dev/api.json
    curl -o DATA/litellm.json https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json

Then run `python3 tools/catalog/alias_eval.py DATA`. It prints two tables:
(1) leave one provider out: for each gateway-like provider of the catalog, the alias table is
built from every other provider and the provider's own canonical ids are the answers;
(2) LiteLLM's chat models, whose own window, reasoning and image values are the answers.
Stages: maker (today's rule), exact (steps 1-10), squash (step 11), loose (step 12).
"""
import json
import re
import sys
import collections
import statistics

DATA = sys.argv[1]
md = json.load(open(f"{DATA}/modelsdev.json"))
ll = json.load(open(f"{DATA}/litellm.json"))

MAKERS = ["deepseek", "zhipuai", "moonshotai-cn", "minimax-cn", "xiaomi", "tencent-tokenhub",
          "openai", "anthropic", "google", "xai", "alibaba-cn"]
MAKER_OF = {
    "anthropic": ["anthropic"], "openai": ["openai"], "google": ["google"], "xai": ["xai"],
    "deepseek": ["deepseek"], "zhipuai": ["zhipuai", "zai"], "moonshotai": ["moonshotai", "moonshotai-cn"],
    "minimax": ["minimax", "minimax-cn"], "alibaba": ["alibaba", "alibaba-cn"], "xiaomi": ["xiaomi"],
    "mistral": ["mistral"], "tencent": ["tencent-tokenhub"],
}
MAKER_PROVIDERS = set(MAKERS) | {p for v in MAKER_OF.values() for p in v}
NOT_CHAT = {"embedding", "image", "video", "speech", "transcription", "reranking", "realtime"}


def facts(m):
    lim = m.get("limit") or {}
    ctx, inp = lim.get("context"), lim.get("input")
    if ctx and inp:
        ctx = min(ctx, inp)
    mods = m.get("modalities") or {}
    return {"ctx": ctx or inp or None, "out": lim.get("output") or None, "reasoning": m.get("reasoning"),
            "images": "image" in (mods.get("input") or []), "tools": m.get("tool_call"),
            "chat": m.get("type") not in NOT_CHAT and "text" in (mods.get("output") or ["text"])}


ALL = [(pid, mid, (m.get("canonical_model_id") or "").lower() or None, facts(m))
       for pid, p in md.items() for mid, m in p["models"].items()]

ROUTER = re.compile(r":(free|thinking|nitro|online|exacto|extended|floor|beta|latest)$")
AT = re.compile(r"@.*$")
REGION = re.compile(r"^(us|eu|apac|ap|au|jp|ca|global|us-gov|in)\.")
BEDROCK_MAKER = re.compile(r"^(anthropic|meta|amazon|mistral|deepseek|openai|qwen|cohere|ai21|writer|moonshotai|minimax|google|zai|nvidia)\.")
VERSION = re.compile(r"(-v\d+(:\d+)?|-\d+:\d+|:\d+)$")
QUANT = re.compile(r"([-_@.](fp8|fp4|int4|int8|awq|gptq|gguf|mlx|bf16|fp16|4bit|8bit|q\d(_k(_[ms])?)?|q\d_\d|nvfp4|mxfp4))+$")
OLLAMA = re.compile(r"^([^:]+):([^:]+)$")
SQUASH_MAKER = ("openai", "anthropic", "google", "meta", "qwen", "alibaba", "deepseek", "zai", "zhipu", "moonshotai",
                "mistralai", "mistral", "xai", "x-ai", "minimax", "nvidia", "microsoft", "ibm", "amazon")
LOOSE = [re.compile(r"-(20\d{6})$"), re.compile(r"-(20\d\d-\d\d-\d\d)$"), re.compile(r"-(\d{4})$"), re.compile(r"-(\d{6})$"),
         re.compile(r"-(\d\d-\d{4})$"), re.compile(r"-(\d\d-\d\d)$"), re.compile(r"^(coding|cc)-"), re.compile(r":[^:/]+$"),
         re.compile(r"-(thinking|think|nothinking|no-thinking|search|high|low|medium|minimal|xhigh|max|turbo|tput|"
                    r"versatile|instant|fast|ultrafast|batch|nothink|all|free|tee|preview|latest|exp)$")]


def variants(x):
    x = x.strip().lower()
    out = []

    def add(v):
        if v and v not in out:
            out.append(v)
    parts = x.split("/")
    for i in range(len(parts)):
        add("/".join(parts[i:]))
    for t in list(out):
        t = ROUTER.sub("", t); add(t)
        t = AT.sub("", t); add(t)
        t = REGION.sub("", t); add(t)
        t = BEDROCK_MAKER.sub("", t); add(t)
        t = VERSION.sub("", t); add(t)
        t = QUANT.sub("", t); add(t)
        m = OLLAMA.match(t)
        if m:
            name, tag = m.groups()
            add(name if tag == "latest" else f"{name}-{tag}")
        add(re.sub(r"(?<=\d)p(?=\d)", ".", t))
        m2 = re.match(r"^(.*?)claude-(\d[\d.-]*?)-(sonnet|opus|haiku|fable|mythos)(.*)$", t)
        if m2:
            add(f"{m2.group(1)}claude-{m2.group(3)}-{m2.group(2)}{m2.group(4)}")
            add(re.sub(r"(?<=\d)\.(?=\d)", "-", f"{m2.group(1)}claude-{m2.group(3)}-{m2.group(2)}{m2.group(4)}"))
        add(re.sub(r"(?<=\d)\.(?=\d)", "-", t))
        add(re.sub(r"(?<=\d)-(?=\d(?!\d{3}))", ".", t))
    return out


def squash(s):
    s = s.lower().rsplit("/", 1)[-1]
    s = REGION.sub("", s)
    for t in SQUASH_MAKER:
        for sep in ".-_":
            if s.startswith(t + sep):
                s = s[len(t) + 1:]
    s = VERSION.sub("", s)
    return re.sub(r"[^a-z0-9]", "", s)


class Index:
    def __init__(self, rows):
        self.by_id = collections.defaultdict(list)
        self.by_canon = collections.defaultdict(list)
        self.bare = collections.defaultdict(set)
        self.sq = collections.defaultdict(set)
        self.maker_rows = {}
        for r in rows:
            self.by_id[r[1].lower()].append(r)
            if r[0] in MAKERS:
                self.maker_rows.setdefault(r[1].lower(), r)
            if r[2]:
                self.by_canon[r[2]].append(r)
                self.bare[r[2].split("/", 1)[-1]].add(r[2])
                self.sq[squash(r[1])].add(r[2])
                self.sq[squash(r[2])].add(r[2])

    def canon_facts(self, c):
        rs = self.by_canon[c]
        own = [r for r in rs if r[0] in MAKER_OF.get(c.split("/")[0], [])]
        if own:
            return own[0][3]
        f = {}
        for k in ("reasoning", "images", "tools", "chat"):
            vals = [r[3][k] for r in rs if r[3][k] is not None]
            f[k] = (sum(1 for v in vals if v) * 2 > len(vals)) if vals else None
        for k in ("ctx", "out"):
            vals = sorted(r[3][k] for r in rs if r[3][k])
            f[k] = statistics.median_low(vals) if vals else None
        return f

    def lookup(self, cand):
        rs = self.by_id.get(cand)
        if rs:
            canons = {r[2] for r in rs if r[2]}
            if len(canons) == 1:
                return next(iter(canons))
            if len(canons) > 1:
                fs = [self.canon_facts(c) for c in canons]
                ctxs = [f["ctx"] for f in fs if f["ctx"]]
                if ctxs and max(ctxs) - min(ctxs) <= 0.06 * max(ctxs) and len({f["reasoning"] for f in fs}) == 1:
                    return sorted(canons, key=len)[0]
                return "ambiguous"
            own = [r for r in rs if r[0] in MAKER_PROVIDERS]
            if own:
                return ("row", own[0])
        cs = self.bare.get(cand)
        if cs and len(cs) == 1:
            return next(iter(cs))
        if cand in self.by_canon:
            return cand
        return None

    def resolve(self, x):
        """(stage, canonical, facts). Stage: maker (today's rule), exact, squash, loose, none."""
        for c in (x.lower(), x.rsplit("/", 1)[-1].lower()):
            if c in self.maker_rows:
                r = self.maker_rows[c]
                return "maker", r[2], r[3]
        for cand in variants(x):
            hit = self.lookup(cand)
            if hit == "ambiguous":
                return "none", None, None
            if isinstance(hit, tuple):
                return "exact", hit[1][2], hit[1][3]
            if hit:
                return "exact", hit, self.canon_facts(hit)
        cs = self.sq.get(squash(x))
        if cs and len(cs) == 1:
            c = next(iter(cs))
            return "squash", c, self.canon_facts(c)
        for v in variants(x):
            for f in LOOSE:
                w = f.sub("", v)
                if w == v:
                    continue
                hit = self.lookup(w)
                if hit and hit != "ambiguous":
                    if isinstance(hit, tuple):
                        return "loose", hit[1][2], hit[1][3]
                    return "loose", hit, self.canon_facts(hit)
        return "none", None, None


def close(a, b):
    return abs(a - b) <= 0.06 * max(a, b)


def same(c, truth):
    return c == truth or c.split("-20")[0] == truth.split("-20")[0] or c.rstrip("0123456789-") == truth.rstrip("0123456789-")


STAGES = ["maker", "exact", "squash", "loose", "none"]


def report(title, n, st):
    print(f"\n== {title}: {n} chat models")
    cum = 0
    for s in STAGES:
        k = st[s]
        if s != "none":
            cum += k["n"]
        lab = f"{k['ok']}/{k['lab']}" if k["lab"] else "-"
        f = lambda a: f"{k[a+'_ok']}/{k[a+'_n']}" if k[a + "_n"] else "-"
        print(f"  {s:7s} {k['n']:5d}  cumulative {100*cum/n:5.1f}%   right model {lab:>11s}   ctx {f('ctx'):>11s}  reasoning {f('reasoning'):>11s}  images {f('images'):>11s}")


# (1) leave one provider out
GATEWAYS = ["openrouter", "vercel", "github-copilot", "amazon-bedrock", "google-vertex-anthropic", "azure",
            "fireworks-ai", "togetherai", "groq", "deepinfra", "siliconflow", "huggingface", "nvidia",
            "cloudflare-workers-ai", "ollama-cloud", "lmstudio", "aihubmix", "302ai", "zenmux", "ofox",
            "requesty", "cortecs", "chutes", "nebius", "baseten", "cerebras", "modelscope",
            "novita-ai", "friendli", "io-net", "venice", "inception", "wandb", "opencode"]
st = collections.defaultdict(collections.Counter)
n = 0
for P in GATEWAYS:
    if P not in md:
        continue
    ix = Index([r for r in ALL if r[0] != P])
    for mid, m in md[P]["models"].items():
        f = facts(m)
        if not f["chat"]:
            continue
        n += 1
        stage, c, rf = ix.resolve(mid)
        k = st[stage]
        k["n"] += 1
        truth = (m.get("canonical_model_id") or "").lower()
        if c and truth:
            k["lab"] += 1
            k["ok"] += 1 if same(c, truth) else 0
        if rf:
            if f["ctx"] and rf.get("ctx"):
                k["ctx_n"] += 1; k["ctx_ok"] += 1 if close(f["ctx"], rf["ctx"]) else 0
            for a in ("reasoning", "images"):
                if f[a] is not None and rf.get(a) is not None:
                    k[a + "_n"] += 1; k[a + "_ok"] += 1 if bool(f[a]) == bool(rf[a]) else 0
report("leave-one-provider-out, 34 gateway-like providers", n, st)

# (2) LiteLLM, as the upstream id a gateway would show
ix = Index(ALL)
st = collections.defaultdict(collections.Counter)
n = 0
for key, v in ll.items():
    if not isinstance(v, dict) or v.get("mode") != "chat" or key.startswith("ft:"):
        continue
    prov = v.get("litellm_provider") or ""
    x = key[len(prov) + 1:] if key.startswith(prov + "/") else key
    x = re.sub(r"^(us-[a-z]+-\d|eu-[a-z]+-\d|ap-[a-z]+-\d)/", "", x)
    x = re.sub(r"^\d+-month-commitment/", "", x)
    n += 1
    stage, c, rf = ix.resolve(x)
    k = st[stage]
    k["n"] += 1
    if rf:
        t = {"ctx": v.get("max_input_tokens"), "reasoning": v.get("supports_reasoning"), "images": v.get("supports_vision")}
        if t["ctx"] and rf.get("ctx"):
            k["ctx_n"] += 1; k["ctx_ok"] += 1 if close(t["ctx"], rf["ctx"]) else 0
        for a in ("reasoning", "images"):
            if t[a] is not None and rf.get(a) is not None:
                k[a + "_n"] += 1; k[a + "_ok"] += 1 if bool(t[a]) == bool(rf[a]) else 0
report("LiteLLM's chat models (its own values as the answer)", n, st)
