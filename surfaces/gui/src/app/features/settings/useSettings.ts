// GET /v1/settings 的共享 hook:加载一次 + refresh + apply(写接口直接返回完整
// Settings 时本地套用,省一次往返)。模型/高级两个 section 各自使用。

import { useCallback, useEffect, useState } from "react";
import { getSettings } from "../../lib/api/settings";
import { apiErrorMessage, type SettingsRead } from "./settingsLogic";

export function useSettings() {
  const [settings, setSettings] = useState<SettingsRead | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSettings((await getSettings()) as SettingsRead);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, "设置加载失败"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = useCallback((next: SettingsRead) => {
    setSettings(next);
    setError(null);
  }, []);

  return { settings, error, refresh, apply };
}
