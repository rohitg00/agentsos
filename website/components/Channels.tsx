import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";
import { channelGroups } from "../data/channels";

export default function Channels() {
  return (
    <section id="channels" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="CHANNELS"
          title="40 Communication Adapters"
          subtitle="Connect your agents to any platform"
        />
        <FadeIn>
          <div>
            {channelGroups.map((group, groupIndex) => (
              <div key={group.category}>
                <h3
                  className={`font-mono text-sm font-semibold uppercase tracking-wider text-primary mb-3 ${groupIndex === 0 ? "mt-0" : "mt-6"}`}
                >
                  {group.category}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {group.channels.map((channel) => (
                    <span
                      key={channel}
                      className="bg-card border border-white/6 rounded-full px-3 py-1.5 text-sm font-mono transition-colors hover:border-primary/30"
                    >
                      {channel}
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
