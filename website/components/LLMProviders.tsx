import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import { providers, type Tier } from "../data/providers";

const monoTierColors: Record<Tier, string> = {
  frontier: "bg-primary/10 text-primary",
  smart: "bg-white/10 text-zinc-300",
  fast: "bg-white/5 text-zinc-400",
  local: "bg-white/[0.03] text-zinc-500",
};

const tierLabels: { tier: Tier; label: string }[] = [
  { tier: "frontier", label: "Frontier" },
  { tier: "smart", label: "Smart" },
  { tier: "fast", label: "Fast" },
  { tier: "local", label: "Local" },
];

export default function LLMProviders() {
  return (
    <section id="providers" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="LLM PROVIDERS"
          title="25 Providers, 47 Models"
          subtitle="From frontier models to local inference"
        />

        <FadeIn className="flex justify-center gap-3 mb-10">
          {tierLabels.map(({ tier, label }) => (
            <span
              key={tier}
              className={`px-3 py-1 rounded-full text-xs font-mono ${monoTierColors[tier]}`}
            >
              {label}
            </span>
          ))}
        </FadeIn>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {providers.map((provider, index) => (
            <FadeIn key={provider.name} delay={index * 30}>
              <div className="bg-card border border-white/6 rounded-xl p-4 card-hover">
                <div className="font-mono font-semibold text-sm">{provider.name}</div>
                <span className={`inline-block mt-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono ${monoTierColors[provider.tier]}`}>
                  {provider.tier}
                </span>
                <div className="text-muted text-xs font-mono mt-2 leading-relaxed">
                  {provider.models.join(", ")}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
