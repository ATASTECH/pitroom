import React, { memo } from "react";
import { ToolRowBase } from "./tool-row-base";

export type GenericToolProps = {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  isPending: boolean;
  isError?: boolean;
};

export const GenericTool = memo(function GenericTool({
  icon,
  title,
  subtitle,
  isPending,
}: GenericToolProps) {
  const Icon = icon;

  return (
    <ToolRowBase
      icon={
        Icon ? (
          <Icon className="w-full h-full shrink-0 text-muted-foreground" />
        ) : undefined
      }
      shimmerLabel={title}
      completeLabel={title}
      isAnimating={isPending}
      detail={subtitle}
    />
  );
});
