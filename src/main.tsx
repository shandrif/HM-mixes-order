import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installReveal } from "./reveal";
import { installRipple } from "./ripple";
import "./styles.css";

installRipple();
installReveal();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
