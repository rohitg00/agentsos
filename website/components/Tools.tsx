import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import { toolCategories, toolProfiles } from "../data/tools";

export default function Tools() {
  return (
    <section id="tools" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="TOOLBOX"
          title="60+ Tools, 14 Categories"
          subtitle="Curated tool profiles for every workflow"
        />
        <FadeIn>
          <div className="flex flex-wrap justify-center gap-2">
            {toolCategories.map((cat) => (
              <span
                key={cat.name}
                className="bg-card border border-white/6 rounded-full px-4 py-2 text-sm font-mono"
              >
                {cat.name}{" "}
                <span className="text-primary">{cat.count}</span>
              </span>
            ))}
          </div>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {toolProfiles.map((profile) => (
              <div
                key={profile.name}
                className="bg-card border border-white/6 rounded-xl p-5 card-hover"
              >
                <h3 className="font-mono font-semibold text-primary">{profile.name}</h3>
                <p className="text-muted text-sm font-mono mt-1">{profile.description}</p>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {profile.tools.map((tool) => (
                    <span
                      key={tool}
                      className="text-xs font-mono bg-white/5 border border-white/6 rounded-full px-2 py-0.5 text-zinc-400"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}
