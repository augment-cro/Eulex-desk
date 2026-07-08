/* global Office */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./globals.css";

Office.onReady(() => {
    const container = document.getElementById("root");
    if (!container) return;
    ReactDOM.createRoot(container).render(<App />);
});
