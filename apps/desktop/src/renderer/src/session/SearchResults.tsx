import { useTranslation } from "react-i18next";
import { callTarget, type ToolView } from "@finx/client";
import { Icon } from "../icons";
import { SiteIcon, siteOrigin } from "../siteIcon";
import { useStore } from "../store";
import { linkMenu, openLink } from "./contentMenus";
import { useScope } from "./scope";

// A web_search call in the conversation (web-search-design §2.5): the words searched for, and when
// opened the pages found, each opening as a reply's link does, then which service answered and
// what failed before it. The details are the kernel's, so this is the same whichever service it was.

type Hit = { title: string; url: string; date?: string | null };
type Tried = { source: string; name?: string; error: string };
type Details = { source: string | null; source_name?: string | null; results: Hit[]; tried: Tried[]; elapsed_ms: number };

/** The words of a web_search call, and the sites it is limited to; null for any other call. */
export function searchCall(tool: Pick<ToolView, "name" | "args">): { query: string; sites: string[] } | null {
  const target = callTarget(tool.name, tool.args);
  if (target.name !== "web_search") return null;
  const sites = target.args.allowed_domains;
  return {
    query: typeof target.args.query === "string" ? target.args.query : "",
    sites: Array.isArray(sites) ? sites.filter((s): s is string => typeof s === "string") : [],
  };
}

/** What the kernel says of a search that ran; a call refused before it searched has none. */
export function searchDetails(tool: ToolView): Details | null {
  const details = tool.result?.details as Partial<Details> | undefined;
  return details && Array.isArray(details.results) && Array.isArray(details.tried) ? (details as Details) : null;
}

/** "Exa 限流，Parallel 连不上" */
function failures(tried: Tried[], t: ReturnType<typeof useTranslation<"session">>["t"]): string {
  return tried.map((x) => t(`webSearch.why.${x.error}` as "webSearch.why.unreachable", { name: x.name ?? x.source })).join(t("webSearch.and"));
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\d?\./, "");
  } catch {
    return url;
  }
};

export function SearchResults({ details }: { details: Details }) {
  const { t } = useTranslation("session");
  const st = useStore();
  const scope = useScope();
  // Every service failed, or none could be used.
  if (details.source === null) {
    return (
      <div className="ws-res">
        <div className="ws-fail">
          <span>{details.tried.length > 0 ? `${failures(details.tried, t)}${t("webSearch.stop")}` : t("webSearch.noneUsable")}</span>
          <button className="btn" onClick={() => window.finx?.openSettings("search")}>
            {t("webSearch.openSettings")}
          </button>
        </div>
      </div>
    );
  }
  const seconds = (details.elapsed_ms / 1000).toFixed(1);
  const name = details.source_name ?? details.source;
  return (
    <div className="ws-res">
      {details.results.map((hit) => {
        const date = hit.date ? ` · ${hit.date.slice(0, 10)}` : "";
        return (
          <a
            key={hit.url}
            className="ws-hit"
            href={hit.url}
            title={hit.url}
            onClick={(e) => {
              e.preventDefault();
              openLink(st, hit.url, scope, e.metaKey || e.ctrlKey);
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              openLink(st, hit.url, scope, true);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void linkMenu(st, hit.url, scope);
            }}
          >
            <SiteIcon origin={siteOrigin(hit.url)} fallback={<Icon name="globe" />} cached />
            <span className="t">{hit.title}</span>
            <span className="m">
              {siteOf(hit.url)}
              {date}
            </span>
          </a>
        );
      })}
      <div className="ws-foot">
        {details.tried.length > 0 ? (
          <>
            <b>{t("webSearch.failedOver", { failed: failures(details.tried, t), name })}</b>
            {" · "}
            {t("webSearch.footAfter", { count: details.results.length, seconds })}
          </>
        ) : (
          t("webSearch.foot", { count: details.results.length, name, seconds })
        )}
      </div>
    </div>
  );
}
