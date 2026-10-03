"use client";
// beui.dev/components/agents/agent-activity

import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { MessageScroller } from "@/components/agents/message-scroller";
import {
  EASE_OUT,
  SPRING_LAYOUT,
  SPRING_SWAP,
} from "@/lib/ease";
import { cn } from "@/lib/utils";
import { ActivityRow } from "./activity-row";
import type {
  AgentActivityContentType,
  AgentActivityItem,
  AgentActivityProps,
} from "./types";

export type {
  AgentActivityContentType,
  AgentActivityItem,
  AgentActivityProps,
  AgentActivitySearch,
  AgentActivityStatus,
  AgentActivityStep,
  AgentActivityText,
  AgentActivityTool,
  AgentActivityTrace,
  AgentSearchResult,
  AgentStepStatus,
  AgentTraceKind,
} from "./types";

function formatDuration(duration: number) {
  const seconds = Math.max(0, Math.round(duration));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function useControllableOpen({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const controlled = open !== undefined;
  const currentOpen = open ?? internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );

  return [currentOpen, setOpen] as const;
}

function getContentType(items: AgentActivityItem[]): AgentActivityContentType {
  const first = items[0]?.type;
  return first && items.every((item) => item.type === first) ? first : "mixed";
}

function getActiveLabel(type: AgentActivityContentType) {
  if (type === "search") return "Searching the web…";
  if (type === "tool") return "Running tools…";
  if (type === "trace") return "Working through the run…";
  if (type === "mixed") return "Working through it…";
  return "Thinking…";
}

function getSummary(
  type: AgentActivityContentType,
  items: AgentActivityItem[],
  duration: number,
): ReactNode {
  if (type === "step" || type === "text") {
    return (
      <>
        Thought for <span className="tabular-nums">{formatDuration(duration)}</span>
      </>
    );
  }
  if (type === "search") return "Searched the web";
  if (type === "tool") {
    return `Ran ${items.length} ${items.length === 1 ? "tool" : "tools"}`;
  }
  if (type === "trace") {
    const messages = items.filter(
      (item) =>
        item.type === "trace" &&
        (item.kind === "thinking" || item.kind === "message"),
    ).length;
    const tools = items.length - messages;
    return `${tools} ${tools === 1 ? "tool call" : "tool calls"}, ${messages} ${messages === 1 ? "message" : "messages"}`;
  }
  return `Completed ${items.length} ${items.length === 1 ? "step" : "steps"}`;
}

export function AgentActivity({
  items,
  contentType: initialContentType,
  status = "working",
  duration = 0,
  open,
  defaultOpen = false,
  onOpenChange,
  collapseOnComplete = true,
  activeLabel,
  summary,
  renderWorkingStatus,
  renderCompletedStatus,
  maxHeight = 208,
  className,
  contentClassName,
}: AgentActivityProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const previousStatus = useRef(status);
  const [currentOpen, setOpen] = useControllableOpen({
    open,
    defaultOpen: defaultOpen || status === 'working',
    onOpenChange,
  });
  const working = status === "working";
  const expanded = currentOpen;
  const contentType = items.length
    ? getContentType(items)
    : (initialContentType ?? "mixed");

  useEffect(() => {
    if (previousStatus.current !== "working" && status === "working") {
      setOpen(true);
    }
    if (previousStatus.current === "working" && status === "complete" && collapseOnComplete) {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [collapseOnComplete, setOpen, status]);

  const toggle = () => {
    const next = !currentOpen;
    setOpen(next);
  };

  const liveLabel = activeLabel ?? getActiveLabel(contentType);
  const completedSummary = summary ?? getSummary(contentType, items, duration);
  const navigationItems = items.map((item, index) => ({
    id: item.id,
    label: item.type === 'trace' ? item.navigationLabel ?? `Step ${index + 1}` : `Step ${index + 1}`,
    description: item.type === 'trace' && typeof item.detail === 'string' ? item.detail : undefined,
  }));

  return (
    <div
      data-state={working ? "working" : expanded ? "open" : "closed"}
      data-content={contentType}
      aria-busy={working}
      className={cn("w-full text-sm", className)}
    >
        <button
          id={triggerId}
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={toggle}
          className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md text-left font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="truncate">
            {working ? (renderWorkingStatus
              ? renderWorkingStatus({ label: liveLabel, duration })
              : <ThinkingShimmer>{liveLabel}</ThinkingShimmer>) : renderCompletedStatus
              ? renderCompletedStatus({ summary: completedSummary, duration })
              : completedSummary}
          </span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="inline-flex shrink-0 text-muted-foreground/70"
          >
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={expanded}
      >
        {expanded && <MessageScroller items={navigationItems} followOutput={working} maxHeight={maxHeight} className={contentClassName}>
            <AnimatePresence mode="popLayout">
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  role="listitem"
                  data-activity-id={item.id}
                  initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                  transition={
                    reduce
                      ? { duration: 0 }
                      : {
                          opacity: { duration: 0.18, ease: EASE_OUT },
                          y: SPRING_LAYOUT,
                        }
                  }
                >
                  <ActivityRow item={item} />
                </motion.div>
              ))}
            </AnimatePresence>
        </MessageScroller>}
      </AgentDisclosure>
    </div>
  );
}
