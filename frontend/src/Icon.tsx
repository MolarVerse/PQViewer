import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Image,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  X,
  type LucideIcon,
} from "lucide-react";

export type IconName =
  | "back"
  | "close"
  | "first"
  | "folder"
  | "image"
  | "last"
  | "more"
  | "next"
  | "pause"
  | "play"
  | "retry"
  | "search"
  | "sliders";

const icons: Record<IconName, LucideIcon> = {
  back: ChevronLeft,
  close: X,
  first: SkipBack,
  folder: FolderOpen,
  image: Image,
  last: SkipForward,
  more: MoreHorizontal,
  next: ChevronRight,
  pause: Pause,
  play: Play,
  retry: RotateCcw,
  search: Search,
  sliders: SlidersHorizontal,
};

export function Icon({ name }: { name: IconName }) {
  const Glyph = icons[name];
  return <Glyph className="icon" aria-hidden="true" strokeWidth={1.7} />;
}
