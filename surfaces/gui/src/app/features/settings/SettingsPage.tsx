// 设置页:左侧 sub-nav(外观/模型/语音/记忆/Personas/高级)+ 右侧 section。
// sub-nav 随页面滚动吸顶;section 各自取数,互不影响。

import { useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { AdvancedSection } from "./AdvancedSection";
import { AppearanceSection } from "./AppearanceSection";
import { MemorySection } from "./MemorySection";
import { ModelsSection } from "./ModelsSection";
import { PersonasSection } from "./PersonasSection";
import { VoiceSection } from "./VoiceSection";
import { BTN } from "./controls";
import { useSettings } from "./useSettings";

type SectionKey = "appearance" | "models" | "voice" | "memory" | "personas" | "advanced";

const SECTIONS: readonly { key: SectionKey; label: string; icon: IconName }[] = [
  { key: "appearance", label: "外观", icon: "sun" },
  { key: "models", label: "模型", icon: "cpu" },
  { key: "voice", label: "语音", icon: "mic" },
  { key: "memory", label: "记忆", icon: "sparkle" },
  { key: "personas", label: "Personas", icon: "agents" },
  { key: "advanced", label: "高级", icon: "settings" },
];

/** 高级区的所有表单共享一份 GET /v1/settings,加载完成后再渲染(表单以 props 初始化草稿)。 */
function AdvancedLoader() {
  const { settings, error, refresh } = useSettings();
  if (!settings) {
    return error ? (
      <div className="py-16 text-center">
        <p className="text-[13px] text-danger">{error}</p>
        <button type="button" className={BTN + " mt-3"} onClick={() => void refresh()}>
          重试
        </button>
      </div>
    ) : (
      <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
        <span className="spinner spinner-lg" /> 加载中
      </div>
    );
  }
  return <AdvancedSection settings={settings} onApplied={() => void refresh()} />;
}

export function SettingsPage() {
  const [section, setSection] = useState<SectionKey>("appearance");

  return (
    <div data-tauri-drag-region className="mx-auto flex max-w-4xl items-start gap-8 px-8 py-8">
      <nav data-tauri-drag-region className="sticky top-8 w-[168px] shrink-0" aria-label="设置">
        {SECTIONS.map((item) => {
          const active = item.key === section;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              aria-current={active ? "page" : undefined}
              className={
                "mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] " +
                (active
                  ? "bg-panel font-semibold text-ink shadow-[0_0_0_0.5px_var(--line-strong),0_1px_2px_rgba(0,0,0,0.04)]"
                  : "text-muted hover:bg-panel/60 hover:text-ink")
              }
            >
              <Icon
                name={item.icon}
                size={14}
                className={active ? "text-accent" : "text-faint"}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 pb-16">
        {section === "appearance" && <AppearanceSection />}
        {section === "models" && <ModelsSection />}
        {section === "voice" && <VoiceSection />}
        {section === "memory" && <MemorySection />}
        {section === "personas" && <PersonasSection />}
        {section === "advanced" && <AdvancedLoader />}
      </div>
    </div>
  );
}
