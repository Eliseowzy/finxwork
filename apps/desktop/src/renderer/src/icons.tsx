// The app's line icons, all from Lucide, under the names the app calls them by.
// Size and stroke width come from `.ic` in styles/app.css; the widths there are in
// Lucide's 24-unit grid.
import markOnDark from "../../../../../assets/brand/app/finxwork-mark-on-dark-256.png";
import markOnLight from "../../../../../assets/brand/app/finxwork-mark-on-light-256.png";
import markSolid from "../../../../../assets/brand/mark/finxwork-mark-solid.svg";
import { animateMark, type MarkMotionOptions } from "../../../../../assets/brand/motion/finxwork-mark-motion.js";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blocks,
  BookOpen,
  Bot,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  CodeXml,
  Copy,
  CornerDownRight,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Folder,
  FolderPlus,
  FolderTree,
  GitBranch,
  Globe,
  Info,
  Key,
  Laptop,
  Layers,
  List,
  ListFilter,
  Lock,
  LockOpen,
  LogOut,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  MessagesSquare,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pause,
  Pencil,
  Pin,
  Plug,
  Plus,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Upload,
  User,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";

const icons = {
  eye: Eye,
  eyeOff: EyeOff,
  search: Search,
  sidebar: PanelLeft,
  gear: Settings,
  plus: Plus,
  doc: FileText,
  list: List,
  more: Ellipsis,
  x: X,
  check: Check,
  minus: Minus,
  chevD: ChevronDown,
  chevR: ChevronRight,
  chevL: ChevronLeft,
  updown: ChevronsUpDown,
  stop: Square,
  arrowUp: ArrowUp,
  arrowDown: ArrowDown,
  arrowLeft: ArrowLeft,
  arrowRight: ArrowRight,
  archive: Archive,
  infoCard: PanelRight,
  info: Info,
  laptop: Laptop,
  tree: FolderTree,
  folder: Folder,
  folderPlus: FolderPlus,
  code: CodeXml,
  file: File,
  key: Key,
  person: User,
  terminal: SquareTerminal,
  copy: Copy,
  ext: ExternalLink,
  edit: Pencil,
  clock: Clock,
  steer: CornerDownRight,
  shield: ShieldCheck,
  lock: Lock,
  unlock: LockOpen,
  logout: LogOut,
  warn: TriangleAlert,
  bolt: Zap,
  sparkle: Sparkles,
  paperclip: Paperclip,
  retry: RotateCw,
  filter: ListFilter,
  cube: Box,
  bot: Bot,
  pin: Pin,
  chats: MessagesSquare,
  layers: Layers,
  pause: Pause,
  blocks: Blocks,
  skill: BookOpen,
  plug: Plug,
  globe: Globe,
  upload: Upload,
  chat: MessageSquare,
  trash: Trash2,
  expand: Maximize2,
  shrink: Minimize2,
  branch: GitBranch,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  const Glyph = icons[name];
  return <Glyph className={`ic ${className}`} aria-hidden="true" />;
}

/** finxwork's mark, the α of assets/brand: the data-point mark from 64 px up, the solid one below (the brand's smallest size for each). */
export function Mark({ size = 18 }: { size?: number }) {
  const style = { display: "block", flex: "none", width: size, height: size };
  if (size < 64) return <img src={markSolid} alt="" draggable={false} style={style} />;
  return (
    <picture style={{ display: "contents" }}>
      <source srcSet={markOnDark} media="(prefers-color-scheme: dark)" />
      <img src={markOnLight} alt="" draggable={false} style={style} />
    </picture>
  );
}

/** The mark in motion (assets/brand/motion): its data points flowing along the stroke. The "strands" look from 96 px up, "solid" below; sized by `size` or by CSS through className. */
export function MarkMotion({ size, className, theme, look, speed, intro, rewrite }: MarkMotionOptions & { size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const motion = animateMark(ref.current!, { theme, look, speed, intro, rewrite });
    return () => motion.stop();
  }, [theme, look, speed, intro, rewrite]);
  return <canvas ref={ref} className={className} aria-hidden="true" style={size ? { display: "block", flex: "none", width: size, height: size } : undefined} />;
}
