// 记忆:助手跨会话记住的偏好与事实。接口只有 GET/POST /v1/memory(无删除端点),
// 所以这里提供列表 + 按作用域添加,不提供删除。

import { useEffect, useState } from "react";
import { addMemory, getMemory } from "../../lib/api/settings";
import type { MemoryItem, MemoryScope } from "../../lib/api/types";
import {
  BTN_ACCENT,
  GRP,
  GRP_H,
  GRP_NOTE,
  Row,
  SectionHeader,
  Segmented,
  TAG,
} from "./controls";
import {
  MEMORY_SCOPE_META,
  MEMORY_SCOPE_OPTIONS,
  apiErrorMessage,
  validateMemoryDraft,
} from "./settingsLogic";

export function MemorySection() {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<MemoryScope>("workspace");
  const [content, setContent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setItems(await getMemory());
      setLoadError(null);
    } catch (err) {
      setLoadError(apiErrorMessage(err, "记忆加载失败"));
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const add = async () => {
    const invalid = validateMemoryDraft(content);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await addMemory(content.trim(), scope);
      if (res.ok === false) {
        setFormError(res.error || "添加失败");
        return;
      }
      setContent("");
      await reload();
    } catch (err) {
      setFormError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="记忆"
        sub="助手在对话中记住的偏好与事实。全局记忆对所有工作区生效;会话记忆只在当前会话内可见。"
      />

      <div className={GRP_H}>添加记忆</div>
      <div className={GRP + " divide-y divide-line"}>
        <Row label="作用域">
          <Segmented
            ariaLabel="记忆作用域"
            options={MEMORY_SCOPE_OPTIONS.map((value) => ({
              value,
              label: MEMORY_SCOPE_META[value].label,
            }))}
            value={scope}
            onChange={setScope}
          />
        </Row>
        <Row label="内容" stack>
          <textarea
            className="w-full rounded-md border border-line bg-paper px-2 py-1.5 text-[12.5px] text-ink outline-none focus:border-lineStrong disabled:opacity-50"
            rows={3}
            placeholder="例如:回复一律使用简体中文"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setFormError(null);
            }}
          />
        </Row>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          {formError ? (
            <span className="min-w-0 truncate text-[12px] text-danger" role="alert">
              {formError}
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            className={BTN_ACCENT + " shrink-0"}
            disabled={busy || !content.trim()}
            onClick={() => void add()}
          >
            {busy ? "添加中…" : "添加"}
          </button>
        </div>
      </div>

      <div className={GRP_H}>已有记忆{items ? `(${items.length})` : ""}</div>
      {loadError ? (
        <div className="py-8 text-center">
          <p className="text-[13px] text-danger">{loadError}</p>
          <button type="button" className={BTN_ACCENT + " mt-3"} onClick={() => void reload()}>
            重试
          </button>
        </div>
      ) : !items ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-faint">
          <span className="spinner" /> 加载中
        </div>
      ) : items.length === 0 ? (
        <div className={GRP + " px-4 py-6 text-center text-[12.5px] text-faint"}>
          还没有记忆。助手会在对话中主动记录,你也可以在上方手动添加。
        </div>
      ) : (
        <div className={GRP + " divide-y divide-line"}>
          {items.map((item) => {
            const meta = MEMORY_SCOPE_META[item.scope] ?? MEMORY_SCOPE_META.session;
            return (
              <div key={item.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className={`${TAG} mt-0.5 shrink-0 ${meta.tint}`}>{meta.label}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                  {item.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className={GRP_NOTE}>单条记忆的删除接口暂未开放;需要清理时可在对话中让助手遗忘。</p>
    </section>
  );
}
