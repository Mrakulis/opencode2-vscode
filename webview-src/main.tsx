import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root missing from webview html");

createRoot(rootEl).render(<App />);
