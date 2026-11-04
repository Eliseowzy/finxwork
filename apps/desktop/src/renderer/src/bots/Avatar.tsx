import { useEffect, useState } from "react";
import { initialOf } from "@finx/client";
import type { Avatar as AvatarSpec, AvatarHue, AvatarShape, BotSummary } from "@finx/protocol";
import markSolid from "../../../../../../assets/brand/mark/finxwork-mark-solid.svg";
import { useStore } from "../store";

// A bot's face (bot-mode-design §6.3, §6.12): a rounded square, never a circle,
// as square as the window; a small white character with two eyes, the first
// character of its name, the FinxWork mark, or an uploaded picture. Its colour
// is its own, the same in both themes, like a photo. While the bot is busy the
// character looks around and blinks, and a mark or letter breathes.

export const hues: Record<AvatarHue, string> = {
  slate: "#6a82b5",
  sage: "#729d84",
  clay: "#c27f69",
  ochre: "#bd9a4f",
  plum: "#9879ae",
  teal: "#5a999e",
  rose: "#bf7f95",
  stone: "#848a94",
};

export const shapes: AvatarShape[] = ["round", "box", "ghost", "cloud", "dome", "cat", "egg", "gem"];

const bodies: Record<AvatarShape, string> = {
  round: '<circle cx="18" cy="21" r="10.5"/>',
  box: '<rect x="8.5" y="11.5" width="19" height="17" rx="5"/>',
  ghost: '<path d="M9 29V18.5a9 9 0 0 1 18 0V29l-3-2.3-3 2.3-3-2.3-3 2.3-3-2.3z"/>',
  cloud: '<path d="M11.3 27.5a5.2 5.2 0 0 1 .3-10.4 7 7 0 0 1 13.2-.9 5.7 5.7 0 0 1 .2 11.3z"/>',
  dome: '<path d="M6 37V27.5C6 19.5 11.4 14 18 14s12 5.5 12 13.5V37z"/>',
  cat: '<path d="M9.4 18.2L10.7 8.4l6.6 4.6zM26.6 18.2L25.3 8.4l-6.6 4.6z"/><circle cx="18" cy="20.6" r="9.4"/>',
  egg: '<ellipse cx="18" cy="20" rx="8.6" ry="10.6"/>',
  gem: '<rect x="10.6" y="10.6" width="14.8" height="14.8" rx="3.8" transform="rotate(45 18 18)"/>',
};

/** Where each character's eyes are: the left one's x, the right one's x, and their y. */
const eyes: Record<AvatarShape, [number, number, number]> = {
  round: [14.3, 21.7, 20.3],
  box: [14, 22, 19.6],
  ghost: [14.6, 21.4, 19.4],
  cloud: [15.2, 21.6, 21.4],
  dome: [14.4, 21.6, 23],
  cat: [14.6, 21.4, 20.4],
  egg: [14.8, 21.2, 19.2],
  gem: [15, 21, 18.2],
};

export type AvatarSize = 22 | 28 | 36 | 64;

/** A bot's uploaded pictures, by bot and version: fetched once (`bots/avatar`). */
const pictures = new Map<string, Promise<string>>();

function usePicture(botId: string | undefined, rev: number | undefined): string | null {
  const st = useStore();
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!botId || rev === undefined || !st.rpc) return;
    const key = `${botId}:${rev}`;
    let got = pictures.get(key);
    if (!got) {
      got = st.rpc.request("bots/avatar", { bot_id: botId }).then((r) => r.data);
      pictures.set(key, got);
      got.catch(() => pictures.delete(key));
    }
    let stop = false;
    void got.then((data) => !stop && setSrc(data), () => {});
    return () => {
      stop = true;
    };
  }, [botId, rev, st.rpc]);
  return src;
}

/**
 * The avatar of `spec`; `name` gives a letter avatar its character, `bot` an uploaded one its
 * picture. `preview` is a picture not uploaded yet (the form's).
 */
export function Avatar({ spec, name, size, busy = false, bot, preview }: { spec: AvatarSpec; name: string; size: AvatarSize; busy?: boolean; bot?: string; preview?: string }) {
  const picture = usePicture(spec.kind === "image" && !preview ? bot : undefined, spec.kind === "image" ? spec.rev : undefined);
  const cls = `bav s${size} ${busy ? "busy" : ""}`;
  switch (spec.kind) {
    case "mark":
      return (
        <span className={`${cls} mark`} aria-hidden="true">
          <img src={markSolid} alt="" draggable={false} />
        </span>
      );
    case "image": {
      const src = preview ?? picture;
      return <span className={`${cls} pic`} aria-hidden="true">{src && <img src={src} alt="" draggable={false} />}</span>;
    }
    case "mono":
      return (
        <span className={cls} style={{ "--h": hues[spec.hue] } as React.CSSProperties} aria-hidden="true">
          <b className="ch">{initialOf(name) || "·"}</b>
        </span>
      );
    case "char": {
      const [a, b, y] = eyes[spec.shape];
      return (
        <span className={cls} style={{ "--h": hues[spec.hue] } as React.CSSProperties} aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <g fill="#fff" fillOpacity=".94" dangerouslySetInnerHTML={{ __html: bodies[spec.shape] }} />
            <g className="eyes" fill="#1d1e24">
              <ellipse cx={a} cy={y} rx="1.45" ry="1.75" />
              <ellipse cx={b} cy={y} rx="1.45" ry="1.75" />
            </g>
          </svg>
        </span>
      );
    }
  }
}

/** A bot's own avatar, moving while it is busy. */
export function BotAvatar({ bot, size, busy }: { bot: BotSummary; size: AvatarSize; busy?: boolean }) {
  return <Avatar spec={bot.avatar} name={bot.name} size={size} busy={busy} bot={bot.id} />;
}
