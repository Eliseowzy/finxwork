import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Avatar as AvatarSpec, AvatarHue, AvatarInput, AvatarShape } from "@finx/protocol";
import { Dialog } from "../components";
import { useStore, type BotSheet as Sheet } from "../store";
import { Avatar, hues, shapes } from "./Avatar";

const hueNames = Object.keys(hues) as AvatarHue[];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** At most 20 characters, as finx keeps names. */
const NAME_MAX = 20;

/**
 * Making a bot, or changing its name and avatar (bot-mode-design §6.3): a
 * name and an avatar, nothing else. A new bot comes with a character and a
 * colour picked at random, so a name and ↩ make one.
 */
export function BotSheet({ sheet }: { sheet: Sheet }) {
  const st = useStore();
  const { t } = useTranslation("bots");
  const editing = sheet.kind === "edit" ? st.bots.find((b) => b.id === sheet.id) : undefined;
  const initial = useMemo<AvatarSpec>(() => editing?.avatar ?? { kind: "char", shape: pick(shapes), hue: pick(hueNames) }, []);
  const [name, setName] = useState(editing?.name ?? "");
  const [avatar, setAvatar] = useState<AvatarSpec>(initial);
  // A picture picked here and not saved yet: its PNG (base64).
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = () => st.set({ botSheet: null });
  const hue = avatar.kind === "char" || avatar.kind === "mono" ? avatar.hue : (initial.kind === "char" || initial.kind === "mono" ? initial.hue : "slate");
  const trimmed = name.trim();
  const ready = trimmed !== "" && Array.from(trimmed).length <= NAME_MAX && !busy;
  const choose = (spec: AvatarSpec) => {
    setAvatar(spec);
    setPng(null);
  };
  const upload = async () => {
    const got = window.finx ? await window.finx.pickAvatar() : await pickInPage();
    if (!got) return;
    if ("error" in got) return st.show(t(got.error === "too_large" ? "sheet.tooLarge" : "sheet.unreadable"), undefined, true);
    setPng(got.png);
    setAvatar({ kind: "image", rev: 0 });
  };
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    // A picture picked here goes up; one the bot has already stays as it is.
    const given: AvatarInput | undefined = png ? { kind: "image", png } : avatar.kind === "image" ? undefined : avatar;
    const ok = await st.run(async () => {
      if (editing) {
        const changed = png !== null || (avatar.kind !== "image" && JSON.stringify(avatar) !== JSON.stringify(editing.avatar));
        await st.call("bots/update", { bot_id: editing.id, name: trimmed !== editing.name ? trimmed : undefined, avatar: changed ? given : undefined });
      } else {
        const r = await st.call("bots/create", { name: trimmed, avatar: given ?? { kind: "char", shape: pick(shapes), hue } });
        st.selectBot(r.bot.id);
      }
    });
    setBusy(false);
    if (ok) close();
  };
  return (
    <Dialog label={editing ? t("sheet.editTitle") : t("sheet.newTitle")} width={440} className="bsheet" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{editing ? t("sheet.editTitle") : t("sheet.newTitle")}</h3>
        <p className="sub">{t("sheet.sub")}</p>
        <div className="bs-top">
          <Avatar spec={avatar} name={trimmed} size={64} bot={editing?.id} preview={png ? `data:image/png;base64,${png}` : undefined} />
          <label className="bs-name">
            <span>{t("sheet.name")}</span>
            <input
              ref={input}
              className="field"
              value={name}
              autoFocus
              maxLength={NAME_MAX}
              placeholder={t("sheet.placeholder")}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="bs-k">{t("sheet.avatar")}</div>
        <div className="bs-shapes" role="radiogroup" aria-label={t("sheet.avatar")}>
          {editing?.default && (
            <button type="button" role="radio" aria-checked={avatar.kind === "mark"} title={t("sheet.mark")} className={`bs-shape ${avatar.kind === "mark" ? "on" : ""}`} onClick={() => choose({ kind: "mark" })}>
              <Avatar spec={{ kind: "mark" }} name="" size={36} />
            </button>
          )}
          {shapes.map((shape: AvatarShape) => {
            const on = avatar.kind === "char" && avatar.shape === shape;
            return (
              <button key={shape} type="button" role="radio" aria-checked={on} title={t(`sheet.shapes.${shape}`)} className={`bs-shape ${on ? "on" : ""}`} onClick={() => choose({ kind: "char", shape, hue })}>
                <Avatar spec={{ kind: "char", shape, hue }} name="" size={36} />
              </button>
            );
          })}
          <button type="button" role="radio" aria-checked={avatar.kind === "mono"} title={t("sheet.mono")} className={`bs-shape ${avatar.kind === "mono" ? "on" : ""}`} onClick={() => choose({ kind: "mono", hue })}>
            <Avatar spec={{ kind: "mono", hue }} name={trimmed || "字"} size={36} />
          </button>
        </div>
        <div className="bs-hues" role="radiogroup" aria-label={t("sheet.avatar")}>
          {hueNames.map((h) => {
            const on = (avatar.kind === "char" || avatar.kind === "mono") && avatar.hue === h;
            return (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={on}
                title={t(`sheet.hues.${h}`)}
                className={`bs-hue ${on ? "on" : ""}`}
                style={{ "--h": hues[h] } as React.CSSProperties}
                onClick={() => choose(avatar.kind === "mono" ? { kind: "mono", hue: h } : { kind: "char", shape: avatar.kind === "char" ? avatar.shape : pick(shapes), hue: h })}
              />
            );
          })}
        </div>
        <div className="sheet-foot">
          <button type="button" className="link left" onClick={() => void upload()}>
            {t("sheet.upload")}
          </button>
          <button type="button" className="btn" onClick={close}>
            {t("sheet.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!ready}>
            {editing ? t("sheet.save") : t("sheet.create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** A picture from the browser's own picker, cropped to a square and scaled to 256 px (a page without the app's bridge). */
function pickInPage(): Promise<{ png: string } | { error: "too_large" | "unreadable" } | null> {
  return new Promise((resolve) => {
    const el = document.createElement("input");
    el.type = "file";
    el.accept = "image/png,image/jpeg,image/heic";
    el.onchange = () => {
      const file = el.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 10 * 1024 * 1024) return resolve({ error: "too_large" });
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 256;
        canvas.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
        resolve({ png: canvas.toDataURL("image/png").split(",")[1] });
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => resolve({ error: "unreadable" });
      img.src = URL.createObjectURL(file);
    };
    el.click();
  });
}
