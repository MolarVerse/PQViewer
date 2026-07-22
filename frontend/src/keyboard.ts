export interface ViewerShortcutLabels {
  commands: string;
  customize: string;
  open: string;
  render: string;
}

export type VimPrefix = "g" | null;

export type VimNavigationAction =
  | "commands"
  | "first-frame"
  | "last-frame"
  | "next-frame"
  | "next-ten-frames"
  | "previous-frame"
  | "previous-ten-frames";

export interface VimNavigationResolution {
  action: VimNavigationAction | null;
  prefix: VimPrefix;
}

export function shortcutLabelsForPlatform(platform: string): ViewerShortcutLabels {
  if (isApplePlatform(platform)) {
    return { commands: "⌘K", customize: "⌘,", open: "⌘O", render: "⌘⇧S" };
  }
  return { commands: "Ctrl K", customize: "Ctrl ,", open: "Ctrl O", render: "Ctrl Shift S" };
}

export function isApplePlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function parseVimPreference(value: string | null): boolean {
  return value === "true";
}

export function advanceFrameIndex(current: number, delta: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  return Math.max(0, Math.min(frameCount - 1, current + delta));
}

export function resolveVimNavigation(key: string, prefix: VimPrefix): VimNavigationResolution {
  if (key === "g") {
    return prefix === "g"
      ? { action: "first-frame", prefix: null }
      : { action: null, prefix: "g" };
  }
  if (key === "G") return { action: "last-frame", prefix: null };
  if (key === "j") return { action: "next-frame", prefix: null };
  if (key === "J") return { action: "next-ten-frames", prefix: null };
  if (key === "k") return { action: "previous-frame", prefix: null };
  if (key === "K") return { action: "previous-ten-frames", prefix: null };
  if (key === ":") return { action: "commands", prefix: null };
  return { action: null, prefix: null };
}
