import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import { agents, hands } from "../data/agents";

const colors = [
  "bg-purple-500/15 text-purple-400",
  "bg-cyan-500/15 text-cyan-400",
  "bg-amber-500/15 text-amber-400",
  "bg-green-500/15 text-green-400",
  "bg-rose-500/15 text-rose-400",
  "bg-blue-500/15 text-blue-400",
];

function initials(name: string) {
  return name.replace(/[a-z]/g, "").slice(0, 2) || name.slice(0, 2).toUpperCase();
}

export default function Agents() {
  return (
    <section id="agents" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="AGENTS"
          title="30 Agent Templates"
          subtitle="Pre-configured agents for every use case, plus 7 autonomous hands"
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-3">
          {agents.map((agent, index) => (
            <FadeIn key={agent.name} delay={index * 30}>
              <div className="bg-card border border-white/6 rounded-xl p-4 text-center card-hover">
                <div className={`w-8 h-8 rounded-lg ${colors[index % colors.length]} flex items-center justify-center mx-auto font-mono text-xs font-bold`}>
                  {initials(agent.name)}
                </div>
                <div className="font-mono text-xs font-semibold mt-2">
                  {agent.name}
                </div>
                <div className="text-muted text-[10px] mt-1">{agent.role}</div>
              </div>
            </FadeIn>
          ))}
        </div>
        <FadeIn delay={400}>
          <div className="mt-10">
            <h3 className="text-lg font-mono font-semibold mb-4">
              Autonomous Hands
            </h3>
            <div className="flex flex-wrap gap-2">
              {hands.map((hand) => (
                <div
                  key={hand.name}
                  className="bg-primary/10 border border-primary/20 rounded-lg px-3 py-2"
                >
                  <span className="text-sm font-mono font-medium text-primary">
                    {hand.name}
                  </span>
                  <span className="text-muted text-xs ml-2">{hand.role}</span>
                </div>
              ))}
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
