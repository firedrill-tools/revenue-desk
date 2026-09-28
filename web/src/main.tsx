import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles/globals.css";

// Spike S1 page; removed when the real chat screen lands.
const ApprovalSpike = lazy(() =>
  import("@/app/spike/ApprovalSpike").then((module) => ({ default: module.ApprovalSpike })),
);

const container = document.getElementById("root");
if (!container) {
  throw new Error("Revenue Desk: #root element is missing from index.html");
}

const isApprovalSpike = window.location.pathname === "/spike/approvals";

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      {isApprovalSpike ? (
        <Suspense fallback={null}>
          <ApprovalSpike />
        </Suspense>
      ) : (
        <App />
      )}
    </TooltipProvider>
  </StrictMode>,
);
