import AgentPanel from "../components/AgentPanel";

export default function AgentPage() {
  return (
    <div className="agent-page">
      <h1>Agent</h1>
      <p className="agent-page-intro">
        用自然语言查询和修改任务、日历、课程、清单与计划。所有写操作都会先列为待确认动作，
        只有你逐条确认后才会真正执行。
      </p>
      <section className="agent-page-card">
        <AgentPanel />
      </section>
    </div>
  );
}
