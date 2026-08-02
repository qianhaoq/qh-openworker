import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, NAV_ITEMS } from "./Sidebar";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Sidebar", () => {
  it("exposes only the four primary navigation items", () => {
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["首页", "Missions", "Agents", "审批"]);
  });

  it("delegates collapse persistence to the shell toggle handler", () => {
    const toggle = vi.fn();
    render(<Sidebar active="home" collapsed={false} onToggleCollapsed={toggle} />);
    fireEvent.click(screen.getByTitle("收起侧栏"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
