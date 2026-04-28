import { Link } from "react-router-dom";
import { Book, Code, Shield, Terminal, Cpu, Layers, FileText, Rocket } from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const guides = [
  { icon: Rocket, title: "Getting Started", desc: "Install, configure, and run your first agent", slug: "getting-started", tag: "guide" },
  { icon: Layers, title: "Primitives", desc: "Worker, Function, and Trigger deep dive", slug: "primitives", tag: "concepts" },
  { icon: Terminal, title: "CLI Reference", desc: "All 50+ commands with examples", slug: "cli", tag: "reference" },
  { icon: Code, title: "TypeScript SDK", desc: "Full API for building agents in TypeScript", slug: "api", tag: "reference" },
  { icon: Cpu, title: "Rust Crates", desc: "10 crates: cli, tui, security, memory, llm-router, wasm", slug: "architecture", tag: "reference" },
  { icon: Shield, title: "Security Model", desc: "RBAC, vault, WASM sandbox, audit trails", slug: "security", tag: "concepts" },
  { icon: Book, title: "Channel Adapters", desc: "Integrate Slack, Discord, GitHub, and 37 more", slug: "channels", tag: "guide" },
  { icon: FileText, title: "Examples", desc: "Code reviewer, researcher, ops bot, and more", slug: "examples", tag: "examples" },
];

const tagColors: Record<string, string> = {
  guide: "text-primary bg-primary/10",
  concepts: "text-zinc-300 bg-white/5",
  reference: "text-zinc-400 bg-white/[0.03]",
  examples: "text-primary/70 bg-primary/5",
};

export default function Docs() {
  return (
    <section id="docs" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="DOCS"
          title="Documentation"
          subtitle="Everything you need to build, deploy, and scale agents."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {guides.map((doc, i) => {
            const Icon = doc.icon;
            return (
              <FadeIn key={doc.title} delay={i * 50}>
                <Link to={`/docs/${doc.slug}`} className="block h-full">
                  <div className="bg-card border border-white/6 rounded-xl p-4 card-hover group cursor-pointer h-full">
                    <div className="flex items-center justify-between mb-3">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                        <Icon size={16} />
                      </div>
                      <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${tagColors[doc.tag]}`}>
                        {doc.tag}
                      </span>
                    </div>
                    <h3 className="font-mono font-semibold text-sm mb-1 group-hover:text-primary transition-colors">{doc.title}</h3>
                    <p className="text-muted text-xs font-mono leading-relaxed">{doc.desc}</p>
                  </div>
                </Link>
              </FadeIn>
            );
          })}
        </div>

        <div className="mt-8 text-center">
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-card border border-white/6 rounded-lg text-sm font-mono text-muted hover:text-white hover:border-white/10 transition-colors"
          >
            View all documentation
          </Link>
        </div>
      </div>
    </section>
  );
}
