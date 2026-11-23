import { DialogHeading, HelpPanels, type HelpPage } from "@molarverse/pq-design";
import { useEffect, useMemo, useRef, useState } from "react";
import { listLaunchFolder, type LaunchFolderEntry } from "./api";

import { searchCommandActions } from "./commandSearch";
import { Icon } from "./Icon";
import type { ViewerShortcutLabels } from "./keyboard";
import { useModalFocus } from "./workspaceFocus";

export interface CommandAction {
  id: string;
  label: string;
  keywords?: string;
  breadcrumb?: string;
  detail?: string;
  disabled?: boolean;
  discoverableWhenDisabled?: boolean;
  run: () => void;
}

export function CommandPalette({
  actions,
  contextIds,
  recentIds,
  resolveAction,
  onClose,
}: {
  actions: CommandAction[];
  contextIds: string[];
  recentIds: string[];
  resolveAction?: (query: string) => CommandAction | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = useMemo(() => {
    const searched = searchCommandActions(actions, query, { contextIds, recentIds });
    const resolved = resolveAction?.(query) ?? null;
    return resolved
      ? [resolved, ...searched.filter((action) => action.id !== resolved.id)]
      : searched;
  }, [actions, contextIds, query, recentIds, resolveAction]);

  useModalFocus(panelRef, inputRef);
  useEffect(() => setActive(0), [visible]);
  useEffect(() => {
    optionRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const move = (direction: number) => {
    if (visible.length === 0) return;
    setActive((current) => (current + direction + visible.length) % visible.length);
  };

  return <div className="command-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="command-palette" role="dialog" aria-modal="true" aria-label="Search" tabIndex={-1}>
      <label className="command-search"><Icon name="search" /><input
        ref={inputRef}
        value={query}
        placeholder="Search atoms, settings, and commands"
        aria-label="Search atoms, settings, and commands"
        role="combobox"
        aria-autocomplete="list"
        aria-controls="command-results"
        aria-expanded="true"
        aria-activedescendant={visible[active] ? `command-${visible[active].id}` : undefined}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
          else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
          else if (event.key === "Enter") {
            event.preventDefault();
            if (!visible[active]?.disabled) visible[active]?.run();
          }
        }}
      /><kbd>esc</kbd></label>
      <div className="command-results" id="command-results" role="listbox">
        {visible.map((action, index) => <button
          ref={(element) => { optionRefs.current[index] = element; }}
          key={action.id}
          id={`command-${action.id}`}
          type="button"
          role="option"
          aria-selected={index === active}
          aria-disabled={action.disabled || undefined}
          className={index === active ? "is-active" : ""}
          onPointerMove={() => setActive(index)}
          onClick={() => {
            if (!action.disabled) action.run();
          }}
        >
          <span className="command-result-copy">
            <span>{action.label}</span>
            {action.breadcrumb && <small>{action.breadcrumb}</small>}
          </span>
          {action.detail && <span className="command-result-detail">{
            action.disabled
              ? <small>{action.detail}</small>
              : <kbd>{action.detail}</kbd>
          }</span>}
        </button>)}
        {visible.length === 0 && <p>No matching atoms, settings, or commands</p>}
      </div>
    </section>
  </div>;
}

export function ShortcutSheet({
  mode,
  onMode,
  shortcutLabels,
  vimMode,
  onVimMode,
  onClose,
}: {
  mode: HelpPage | null;
  onMode: (mode: HelpPage) => void;
  shortcutLabels: ViewerShortcutLabels;
  vimMode: boolean;
  onVimMode: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const groups: Array<{ title: string; items: Array<[string, string]> }> = [
    {
      title: "Trajectory",
      items: [
        ["← / →", "Previous / next frame"],
        ["Shift ← / →", "Move ten frames"],
        ["Home / End", "First / last frame"],
        ["Space", "Play / pause"],
        ["M", "Bookmark frame"],
      ],
    },
    {
      title: "View",
      items: [
        ["R", "Fit structure"],
        ["1 / 2 / 3 / 4", "3D / XY / XZ / YZ"],
        ["↑ / ↓", "Browse atoms"],
        ["Enter", "Toggle atom"],
        ["E / V", "Edit / View tools"],
        ["B", "Bonds / lines"],
        ["C / F / W", "Cell / forces / water"],
      ],
    },
    {
      title: "Workspace",
      items: [
        [`${shortcutLabels.commands} or /`, "Search atoms, settings, commands"],
        [shortcutLabels.open, "Open files"],
        [shortcutLabels.export, "Export figure"],
        ["? / Esc", "Shortcuts / close"],
      ],
    },
  ];
  const vimItems: Array<[string, string]> = [
    ["l / h", "Next / previous frame"],
    ["L / H", "Forward / back ten"],
    ["gg / G", "First / last frame"],
    [":", "Search atoms, settings, commands"],
    ["Ctrl [", "Close surface"],
  ];

  return <HelpPanels
    page={mode}
    onPage={(page) => page ? onMode(page) : onClose()}
    docs="https://molarverse.github.io/PQViewer/viewer-guide.html"
    intro={<p>Open a structure or trajectory. Drag to rotate, select an atom to inspect it, or use Analyze to measure distances and angles.</p>}
    groups={vimMode ? [...groups, { title: "Vim navigation", items: vimItems }] : groups}
    shortcutOptions={<div className="pq-help-options">
      <span>Vim navigation</span>
      <button type="button" aria-label="Vim navigation" aria-pressed={vimMode}
        onClick={() => onVimMode(!vimMode)}>{vimMode ? "On" : "Off"}</button>
    </div>}
  />;
}

export function OpenDialog({ onClose, onUpload, onFile }: {
  onClose: () => void;
  onUpload: () => void;
  onFile: (path: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [folder, setFolder] = useState<string[]>([]);
  const [entries, setEntries] = useState<LaunchFolderEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const path = folder.join("/");
  useModalFocus(panelRef);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    listLaunchFolder(path, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setEntries(value); },
      (failure: Error) => { if (!controller.signal.aborted) setError(failure.message); },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path]);

  return <div className="command-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="command-palette open-dialog" role="dialog" aria-modal="true" aria-label="Open files" tabIndex={-1}>
      <DialogHeading title="Open files" onClose={onClose} />
      {(loading || entries !== null || error) && <>
        <div className="open-dialog-location">
          {folder.length > 0 && <button type="button" className="open-dialog-icon" aria-label="Parent folder" onClick={() => setFolder(folder.slice(0, -1))}>
            <Icon name="back" />
          </button>}
          <span title={["Launch folder", ...folder].join(" / ")}>{["Launch folder", ...folder].join(" / ")}</span>
        </div>
        <div className="command-results" aria-busy={loading}>
          {loading ? <p>Reading folder…</p>
            : error ? <p role="alert">{error}</p>
            : entries?.length ? entries.map(({ name, directory }) =>
              <button key={name} type="button" onClick={() => {
                if (directory) setFolder([...folder, name]);
                else onFile([...folder, name].join("/"));
              }}>
                <span>{directory && <Icon name="folder" />}{name}</span>
                {directory && <Icon name="next" />}
              </button>)
            : <p>No supported files or folders here.</p>}
        </div>
      </>}
      <footer className="open-dialog-footer">
        <button type="button" className="open-dialog-upload" onClick={onUpload}>Upload from this device</button>
      </footer>
    </section>
  </div>;
}
