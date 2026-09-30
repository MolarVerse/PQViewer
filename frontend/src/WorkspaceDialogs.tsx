import { useEffect, useMemo, useRef, useState } from "react";
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
  shortcutLabels,
  vimMode,
  onVimMode,
  onClose,
}: {
  shortcutLabels: ViewerShortcutLabels;
  vimMode: boolean;
  onVimMode: (enabled: boolean) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useModalFocus(panelRef);
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
        [shortcutLabels.commands, "Search atoms, settings, commands"],
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

  return <div className="command-backdrop shortcut-backdrop" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
    <section ref={panelRef} className="shortcut-panel" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex={-1}>
      <div className="shortcut-heading">
        <div><strong>Keyboard shortcuts</strong><span>Everything remains available with the mouse.</span></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close keyboard shortcuts"><Icon name="close" /></button>
      </div>
      <div className="shortcut-groups">
        {groups.map((group) => <section key={group.title}>
          <h3>{group.title}</h3>
          {group.items.map(([keys, label]) => <div className="shortcut-row" key={`${keys}:${label}`}><kbd>{keys}</kbd><span>{label}</span></div>)}
        </section>)}
      </div>
      <section className={vimMode ? "vim-shortcuts is-active" : "vim-shortcuts"}>
        <div className="vim-heading">
          <div><strong>Vim navigation</strong><span>Optional; standard shortcuts stay active.</span></div>
          <button type="button" role="switch" aria-label="Vim navigation" aria-checked={vimMode} onClick={() => onVimMode(!vimMode)}><i /></button>
        </div>
        {vimMode && <div className="vim-shortcut-grid">
          {vimItems.map(([keys, label]) => <div className="shortcut-row" key={`${keys}:${label}`}><kbd>{keys}</kbd><span>{label}</span></div>)}
        </div>}
      </section>
    </section>
  </div>;
}
