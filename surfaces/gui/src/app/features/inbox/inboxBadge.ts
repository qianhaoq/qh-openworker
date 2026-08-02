// 侧栏收件箱徽标的跨组件刷新通道。收件箱页处理完任何事项后 dispatch 这个事件,
// App.tsx(徽标的唯一 owner)监听它并重新拉取 pending 计数 —— 比共享 hook 的改动面小,
// 也不占用 App.tsx 里其它并行工作的空间。

export const INBOX_CHANGED_EVENT = "qh:inbox-changed";

export function refreshInboxBadge(): void {
  window.dispatchEvent(new CustomEvent(INBOX_CHANGED_EVENT));
}
