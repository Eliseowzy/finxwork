// The ribbon's icon set: Lucide, imported by name so the bundle keeps only these.
import {
  AArrowDown, AArrowUp, AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignJustify, AlignLeft, AlignRight, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDown, ArrowDownUp, ArrowUp,
  BetweenHorizontalStart, BetweenVerticalStart, Bold, BringToFront, Brush, CalendarDays, CaseSensitive, ChartColumn, Check, ChevronDown, ClipboardPaste,
  Columns2, Copy, CopyPlus, Crop, Ellipsis, Eye, EyeOff, Film, FlipHorizontal2, FlipVertical2, Frame, Grid2x2, Grid3x3, Group, Hash, Highlighter, Image, ImageUp,
  IndentDecrease, IndentIncrease, Italic, Layers, LayoutTemplate, LetterText, Link, List, ListOrdered, Magnet, Maximize, MonitorPlay, MoveHorizontal, PaintBucket,
  Paintbrush, Palette, PanelBottom, PenLine, Play, Plus, RemoveFormatting, Replace, RotateCcw, RotateCw, Rows3, Scan, Scissors, Search, SendToBack, Shapes, Sheet,
  Smile, Sparkles, Square, SquareMousePointer, Strikethrough, Subscript, Superscript, TableCellsMerge, Table, Trash2, Type, Underline, Undo2, Redo2, Ungroup,
  WandSparkles, WrapText, X, ZoomIn, ZoomOut, Baseline, Space, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  AArrowDown, AArrowUp, AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignJustify, AlignLeft, AlignRight, AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowDown, ArrowDownUp, ArrowUp,
  BetweenHorizontalStart, BetweenVerticalStart, Bold, BringToFront, Brush, CalendarDays, CaseSensitive, ChartColumn, Check, ChevronDown, ClipboardPaste,
  Columns2, Copy, CopyPlus, Crop, Ellipsis, Eye, EyeOff, Film, FlipHorizontal2, FlipVertical2, Frame, Grid2x2, Grid3x3, Group, Hash, Highlighter, Image, ImageUp,
  IndentDecrease, IndentIncrease, Italic, Layers, LayoutTemplate, LetterText, Link, List, ListOrdered, Magnet, Maximize, MonitorPlay, MoveHorizontal, PaintBucket,
  Paintbrush, Palette, PanelBottom, PenLine, Play, Plus, RemoveFormatting, Replace, RotateCcw, RotateCw, Rows3, Scan, Scissors, Search, SendToBack, Shapes, Sheet,
  Smile, Sparkles, Square, SquareMousePointer, Strikethrough, Subscript, Superscript, TableCellsMerge, Table, Trash2, Type, Underline, Undo2, Redo2, Ungroup,
  WandSparkles, WrapText, X, ZoomIn, ZoomOut, Baseline, Space,
};

export function RIcon({ name, className = "" }: { name: string; className?: string }) {
  const Glyph = ICONS[name] ?? Square;
  return <Glyph className={`ic ${className}`} aria-hidden="true" data-icon={name} />;
}
