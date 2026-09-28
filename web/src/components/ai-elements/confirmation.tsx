"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

// revenue-desk patch (#484): derive the approval type from the SDK instead of a
// hand copy, which drifted in ai v7 (descriptor, requestReason, isAutomatic).
type ToolUIPartApproval = ToolUIPart["approval"] | DynamicToolUIPart["approval"];

interface ConfirmationContextValue {
  approval: ToolUIPartApproval;
  state: ToolUIPart["state"];
}

const ConfirmationContext = createContext<ConfirmationContextValue | null>(
  null
);

const useConfirmation = () => {
  const context = useContext(ConfirmationContext);

  if (!context) {
    throw new Error("Confirmation components must be used within Confirmation");
  }

  return context;
};

export type ConfirmationProps = ComponentProps<"section"> & {
  approval?: ToolUIPartApproval;
  state: ToolUIPart["state"];
};

export const Confirmation = ({
  className,
  approval,
  state,
  ...props
}: ConfirmationProps) => {
  const contextValue = useMemo(() => ({ approval, state }), [approval, state]);

  if (!approval || state === "input-streaming" || state === "input-available") {
    return null;
  }

  // revenue-desk patch (#484): a polite live region instead of the shadcn
  // Alert's role="alert", which interrupted screen readers for every card.
  return (
    <ConfirmationContext.Provider value={contextValue}>
      <section
        aria-live="polite"
        className={cn(
          "flex flex-col gap-3 rounded-xl border bg-background p-4 text-body",
          className
        )}
        data-slot="confirmation"
        {...props}
      />
    </ConfirmationContext.Provider>
  );
};

export type ConfirmationTitleProps = ComponentProps<"p">;

export const ConfirmationTitle = ({
  className,
  ...props
}: ConfirmationTitleProps) => (
  <p className={cn("font-medium text-foreground", className)} {...props} />
);

export interface ConfirmationRequestProps {
  children?: ReactNode;
}

export const ConfirmationRequest = ({ children }: ConfirmationRequestProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return children;
};

export interface ConfirmationAcceptedProps {
  children?: ReactNode;
}

export const ConfirmationAccepted = ({
  children,
}: ConfirmationAcceptedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when approved and in response states
  if (
    !approval?.approved ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};

export interface ConfirmationRejectedProps {
  children?: ReactNode;
}

export const ConfirmationRejected = ({
  children,
}: ConfirmationRejectedProps) => {
  const { approval, state } = useConfirmation();

  // Only show when rejected and in response states
  if (
    approval?.approved !== false ||
    (state !== "approval-responded" &&
      state !== "output-denied" &&
      state !== "output-available")
  ) {
    return null;
  }

  return children;
};

export type ConfirmationActionsProps = ComponentProps<"div">;

export const ConfirmationActions = ({
  className,
  ...props
}: ConfirmationActionsProps) => {
  const { state } = useConfirmation();

  // Only show when approval is requested
  if (state !== "approval-requested") {
    return null;
  }

  return (
    <div
      className={cn("flex items-center justify-end gap-2 self-end", className)}
      {...props}
    />
  );
};

export type ConfirmationActionProps = ComponentProps<typeof Button>;

// revenue-desk patch: callers that pass className restate the sizing classes;
// merged here so a danger colour does not drop the height and padding.
export const ConfirmationAction = ({
  className,
  ...props
}: ConfirmationActionProps) => (
  <Button className={cn("h-8 px-3 text-sm", className)} type="button" {...props} />
);
