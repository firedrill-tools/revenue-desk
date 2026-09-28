import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Revenue Desk: #root element is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <TooltipProvider>
      <App />
    </TooltipProvider>
  </StrictMode>,
);
