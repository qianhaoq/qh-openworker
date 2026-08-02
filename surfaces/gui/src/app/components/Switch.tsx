// macOS 风格开关(pill toggle):取代「复选框当启用开关」的用法 —— 行内的复选框读起来像
// 多选。button[role=switch] + aria-checked,受控:父级在 mutation + refetch 后才翻转
// `checked`(与旧复选框同一节奏,点完不会立刻自己跳)。点击与 Space/Enter 都被本控件吃掉
// (stopPropagation),不会误触发所在行的「点击打开」行为;焦点环走 design.css 的全局
// :focus-visible。

export function Switch({
  checked,
  disabled,
  title,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  /** 悬浮提示,同时充当可访问名(如「启用 / 停用」)。 */
  title?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      onKeyDown={(e) => {
        // 原生 button 的 Space/Enter 激活照常发生;只是别冒泡给可点击的行容器。
        if (e.key === " " || e.key === "Enter") e.stopPropagation();
      }}
      className={`inline-flex h-[18px] w-[31px] shrink-0 cursor-pointer items-center rounded-full p-[2px] transition-colors disabled:cursor-default disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-lineStrong"
      }`}
    >
      <span
        className={`h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-[13px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}
