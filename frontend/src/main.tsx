import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider, App as AntApp } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import "./style.css";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#245c48",
          colorInfo: "#245c48",
          colorSuccess: "#2f7d5b",
          colorWarning: "#b7791f",
          colorError: "#c62828",
          colorText: "#243b31",
          colorTextSecondary: "#5f6c65",
          colorTextTertiary: "#7a867f",
          colorTextQuaternary: "#a0aaa5",
          fontWeightStrong: 600,
          colorBorder: "#d9e0d7",
          colorBorderSecondary: "#e4e8e1",
          borderRadius: 10,
          controlHeight: 36,
          fontFamily:
            'system-ui, -apple-system, "PingFang SC", sans-serif',
          fontSize: 14,
        },
        components: {
          Button: { fontWeight: 500 },
          Select: { optionSelectedBg: "#eaf1e9" },
        },
      }}
    >
      <AntApp message={{ maxCount: 2, duration: 2 }}>
        <QueryClientProvider client={client}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
