import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Drawer", () => {
  it("sets initial focus and traps tab focus inside the dialog", () => {
    render(
      <Drawer title="测试抽屉" initialFocus="#second" onClose={() => {}}>
        <div className="p-4">
          <button type="button">first</button>
          <button id="second" type="button">
            second
          </button>
        </div>
      </Drawer>,
    );

    const second = screen.getByText("second");
    const close = screen.getByTitle("关闭");
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);
  });

  it("closes on Escape when clean", () => {
    const onClose = vi.fn();
    render(
      <Drawer title="测试抽屉" onClose={onClose}>
        <button type="button">inside</button>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener after close", () => {
    function Fixture() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开</button>
          {open && <Drawer title="测试" onClose={() => setOpen(false)}><button type="button">内容</button></Drawer>}
        </>
      );
    }
    render(<Fixture />);
    const opener = screen.getByText("打开");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });

  it("asks before closing a dirty draft", () => {
    const onClose = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <Drawer title="测试抽屉" dirty onClose={onClose}>
        <button type="button">inside</button>
      </Drawer>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(window.confirm).toHaveBeenCalledWith("有未保存的修改，确定关闭？");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("lets a focused text control consume Escape before the drawer", () => {
    const onClose = vi.fn();
    render(
      <Drawer title="测试抽屉" onClose={onClose}>
        <textarea aria-label="草稿" />
      </Drawer>,
    );
    const draft = screen.getByLabelText("草稿");
    draft.focus();
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
