// 集成 page — external services in one place. A quiet left sub-nav (the mock's
// System-Settings grammar) switches four tabs: 连接器 / MCP 服务器 / 消息路由 / 审计.
// Each tab owns its data hook; this file is assembly only.

import { useState } from "react";
import { ConnectorsView } from "./ConnectorsView";
import { McpServersView } from "./McpServersView";
import { RoutingView } from "./RoutingView";
import { AuditLogView } from "./AuditLogView";

type Tab = "connectors" | "mcp" | "routing" | "audit";

const TABS: { key: Tab; label: string }[] = [
  { key: "connectors", label: "连接器" },
  { key: "mcp", label: "MCP 服务器" },
  { key: "routing", label: "消息路由" },
  { key: "audit", label: "审计" },
];

export function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>("connectors");

  return (
    <div data-tauri-drag-region className="flex h-full">
      <nav data-tauri-drag-region className="w-[208px] shrink-0 border-r border-line bg-panel/40 px-3 py-6">
        <div className="mb-3 px-2 text-[13.5px] font-semibold tracking-tight">集成</div>
        <div className="space-y-0.5">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              data-testid={`integrations-tab-${key}`}
              onClick={() => setTab(key)}
              className={`w-full rounded-lg px-2.5 py-2 text-left text-[13px] ${
                tab === key
                  ? "bg-paper font-medium text-accent"
                  : "text-muted hover:bg-paper hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>
      <div className="hairline-scroll min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          {tab === "connectors" && <ConnectorsView />}
          {tab === "mcp" && <McpServersView />}
          {tab === "routing" && <RoutingView />}
          {tab === "audit" && <AuditLogView />}
        </div>
      </div>
    </div>
  );
}
