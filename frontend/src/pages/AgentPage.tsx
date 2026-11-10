import AgentPanel from "../components/AgentPanel";

export default function AgentPage() {
  return (
    <div className="agent-page">
      <h1>Agent</h1>
      <p className="agent-page-intro">
        用自然语言管理任务、日历、课程、清单与计划。普通任务直接创建，清单和提醒可稍后调整，
        也可以撤销创建；其他写操作需要确认。
      </p>
      <section className="agent-page-card">
        <AgentPanel />
      </section>
    </div>
  );
}
