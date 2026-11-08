import { useState } from "react";
import { Drawer } from "antd";
import { Link } from "react-router-dom";
import AgentPanel from "./AgentPanel";

export default function AgentDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="agent-launcher"
        aria-label="打开 Agent"
        onClick={() => setOpen(true)}
      >
        <span className="agent-launcher-dot" />
        Agent
      </button>
      <Drawer
        title="Student Agent"
        placement="right"
        width="min(460px, 100vw)"
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Link to="/agent" onClick={() => setOpen(false)}>
            展开页面
          </Link>
        }
        styles={{ body: { padding: 12, display: "flex" } }}
      >
        <AgentPanel compact />
      </Drawer>
    </>
  );
}
