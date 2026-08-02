// The app chrome's left sidebar: brand, the seven top-level destinations, and a
// collapse toggle that folds it into an icon rail. Nav items are plain hash anchors —
// the router (app/nav.ts) picks the change up; `active` comes from useRoute().

import type { RouteName } from "../nav";
import { Icon, type IconName } from "./Icon";

export interface NavItem {
  name: RouteName;
  label: string;
  icon: IconName;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { name: "assistant", label: "助理", icon: "assistant" },
  { name: "agents", label: "Agents", icon: "agents" },
  { name: "missions", label: "任务", icon: "missions" },
  { name: "inbox", label: "收件箱", icon: "inbox" },
  { name: "automations", label: "自动化", icon: "automations" },
  { name: "integrations", label: "集成", icon: "integrations" },
  { name: "settings", label: "设置", icon: "settings" },
];

export interface SidebarProps {
  active: RouteName;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Pending counts per destination (e.g. { inbox: 3 }); absent/0 renders nothing. */
  badges?: Partial<Record<RouteName, number>>;
}

export function Sidebar({ active, collapsed, onToggleCollapsed, badges }: SidebarProps) {
  return (
    <aside
      className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-150 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Brand — also the window-drag strip on macOS (overlay title bar); CSS shifts
          it right of the traffic lights, or down when collapsed to the rail. */}
      <div
        data-tauri-drag-region
        className={`sidebar-brand flex items-center gap-2.5 px-3.5 pb-3 pt-3.5 ${
          collapsed ? "sidebar-brand-collapsed justify-center px-2" : ""
        }`}
      >
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent">
          <Icon name="brand" size={15} />
        </div>
        {!collapsed && <div className="truncate text-[14px] font-semibold tracking-tight">QH 助理</div>}
        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            title="收起侧栏"
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="collapse" />
          </button>
        )}
      </div>

      {/* The rail's expand button sits where the brand row's toggle was. */}
      {collapsed && (
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={onToggleCollapsed}
            title="展开侧栏"
            className="grid h-8 w-full place-items-center rounded-md text-faint hover:bg-paper hover:text-ink"
          >
            <Icon name="expand" />
          </button>
        </div>
      )}

      {/* Destinations */}
      <nav className="hairline-scroll flex-1 space-y-0.5 overflow-y-auto px-2.5 pb-3">
        {NAV_ITEMS.map((item) => {
          const isActive = item.name === active;
          const badge = badges?.[item.name] ?? 0;
          return (
            <a
              key={item.name}
              href={`#/${item.name}`}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-2.5 rounded-lg py-2 text-[13px] ${
                collapsed ? "justify-center px-0" : "px-2.5"
              } ${
                isActive
                  ? "accent-grad-soft font-medium text-accent"
                  : "text-ink hover:bg-paper"
              }`}
            >
              <span className="relative shrink-0">
                <Icon
                  name={item.icon}
                  size={17}
                  className={isActive ? "text-accent" : "text-muted"}
                />
                {collapsed && badge > 0 && (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
                )}
              </span>
              {!collapsed && <span className="truncate">{item.label}</span>}
              {!collapsed && badge > 0 && (
                <span className="ml-auto rounded-full bg-accent px-1.5 text-[10.5px] font-semibold leading-[16px] text-white">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
