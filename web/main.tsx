import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";
import "./console.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
const app = (
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
);
const standaloneHome =
  window.location.pathname === "/" &&
  window.matchMedia("(display-mode: standalone)").matches;
if (root.hasChildNodes() && !standaloneHome) hydrateRoot(root, app);
else createRoot(root).render(app);
