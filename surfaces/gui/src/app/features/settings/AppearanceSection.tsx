// 外观:浅色/深色/跟随系统。偏好在 localStorage(src/theme.ts 的 openwork-theme),
// 首帧由 index.html 预置 data-theme,这里只是它的控制台。accent/密度设计令牌不支持,不做。

import { useThemePref } from "../../../theme";
import { GRP, GRP_H, GRP_NOTE, SectionHeader, Segmented } from "./controls";
import { THEME_OPTIONS } from "./settingsLogic";

export function AppearanceSection() {
  const [theme, setTheme] = useThemePref();

  return (
    <section>
      <SectionHeader title="外观" sub="应用的明暗外观。偏好保存在本机,立即生效。" />
      <div className={GRP_H}>主题</div>
      <div className={GRP + " px-4 py-3"}>
        <Segmented
          ariaLabel="外观主题"
          options={THEME_OPTIONS}
          value={theme}
          onChange={setTheme}
        />
      </div>
      <p className={GRP_NOTE}>「跟随系统」会随 macOS 的外观自动切换浅色与深色。</p>
    </section>
  );
}
