import { Network, Brain, History, Lock, CheckCircle, SlidersHorizontal, Wrench, Box, Plug, Globe, Radio, DollarSign } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import { features } from "../data/features";

const iconMap: Record<string, React.ReactNode> = {
  swarm: <Network size={18} />,
  graph: <Brain size={18} />,
  replay: <History size={18} />,
  vault: <Lock size={18} />,
  approval: <CheckCircle size={18} />,
  profiles: <SlidersHorizontal size={18} />,
  skillkit: <Wrench size={18} />,
  wasm: <Box size={18} />,
  mcp: <Plug size={18} />,
  browser: <Globe size={18} />,
  stream: <Radio size={18} />,
  cost: <DollarSign size={18} />,
};

export default function Features() {
  return (
    <section id="features" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="CAPABILITIES"
          title="Everything You Need"
          subtitle="60+ tools across 14 categories, production-ready out of the box"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {features.map((feature, index) => (
            <FadeIn key={feature.title} delay={index * 50}>
              <div className="bg-card border border-white/6 rounded-xl p-5 card-hover">
                <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-3">
                  {iconMap[feature.icon]}
                </div>
                <h3 className="font-mono font-semibold text-sm mb-1.5">
                  {feature.title}
                </h3>
                <p className="text-muted text-xs leading-relaxed font-mono">
                  {feature.description}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
