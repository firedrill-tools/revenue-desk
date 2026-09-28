import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { applyTheme, readTheme } from "@/lib/theme";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Revenue Desk: #root element is missing from index.html");
}

// Before the first render, so the saved theme never flashes.
applyTheme(readTheme());

createRoot(container).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
