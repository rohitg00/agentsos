import { Cog, Brackets, Zap } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const primitives = [
  {
    icon: <Cog size={24} />,
    title: "Worker",
    description:
      "Long-running processes that maintain state across invocations. The compute backbone.",
    borderColor: "border-t-2 border-primary",
  },
  {
    icon: <Brackets size={24} />,
    title: "Function",
    description:
      "Stateless computations that transform data. Pure, composable, chainable.",
    borderColor: "border-t-2 border-primary/60",
  },
  {
    icon: <Zap size={24} />,
    title: "Trigger",
    description:
      "Event listeners that activate workflows. HTTP, cron, webhook, queue.",
    borderColor: "border-t-2 border-primary/30",
  },
];

export default function Primitives() {
  return (
    <section id="primitives" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="FOUNDATION"
          title="Three Primitives"
          subtitle="Everything is a Worker, Function, or Trigger"
        />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {primitives.map((primitive, index) => (
            <FadeIn key={primitive.title} delay={index * 100}>
              <div
                className={`bg-card border border-white/6 rounded-xl p-6 card-hover ${primitive.borderColor}`}
              >
                <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-4">
                  {primitive.icon}
                </div>
                <h3 className="font-mono font-semibold text-lg mb-2">
                  {primitive.title}
                </h3>
                <p className="text-muted text-sm leading-relaxed font-mono">
                  {primitive.description}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
