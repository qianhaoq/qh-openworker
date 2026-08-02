// Centered placeholder for pages whose real implementation lands in a later phase:
// an icon chip, the page title, and a one-line description.

import { Icon, type IconName } from "./Icon";

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description: string;
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="flex h-full min-h-[320px] items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl2 bg-accentSoft text-accent">
          <Icon name={icon} size={20} />
        </div>
        <h1 className="mt-4 text-[15px] font-semibold tracking-tight">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{description}</p>
      </div>
    </div>
  );
}
