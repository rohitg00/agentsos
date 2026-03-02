import {
  Shield,
  Lock,
  FileCheck,
  Box,
  KeyRound,
  ShieldCheck,
  ShieldOff,
  Hash,
  Database,
  Timer,
  Atom,
  ScanSearch,
  Gauge,
  ScanEye,
  PackageSearch,
  Network,
  Fingerprint,
  FileKey,
} from "lucide-react";
import FadeIn from "./shared/FadeIn";
import SectionHeader from "./shared/SectionHeader";

const layers = [
  {
    name: "RBAC",
    desc: "Role-based access control with granular permissions",
    icon: Shield,
  },
  {
    name: "MAP Auth",
    desc: "Merkle-tree audit proof for tamper-evident logs",
    icon: FileCheck,
  },
  {
    name: "Merkle Trail",
    desc: "Immutable, verifiable operation history",
    icon: Hash,
  },
  {
    name: "WASM Sandbox",
    desc: "Wasmtime isolation with memory and fuel limits",
    icon: Box,
  },
  { name: "Vault", desc: "AES-256-GCM secrets with key rotation", icon: Lock },
  {
    name: "Timing-Safe HMAC",
    desc: "Constant-time comparison prevents timing attacks",
    icon: KeyRound,
  },
  {
    name: "Fail-Closed",
    desc: "All operations denied unless explicitly allowed",
    icon: ShieldOff,
  },
  {
    name: "Nonce Invalidation",
    desc: "One-time tokens prevent replay attacks",
    icon: Fingerprint,
  },
  {
    name: "SQL Prevention",
    desc: "Parameterized queries and input sanitization",
    icon: Database,
  },
  {
    name: "Approval Backoff",
    desc: "Exponential delay on repeated denials",
    icon: Timer,
  },
  {
    name: "Replay Atomicity",
    desc: "Atomic session replay prevents partial state",
    icon: Atom,
  },
  {
    name: "Input Validation",
    desc: "Strict schema validation on all API boundaries",
    icon: ShieldCheck,
  },
  {
    name: "Rate Limiting",
    desc: "Per-agent and per-tool request throttling",
    icon: Gauge,
  },
  {
    name: "Secret Scanning",
    desc: "Automatic detection of leaked credentials",
    icon: ScanSearch,
  },
  {
    name: "Dep Auditing",
    desc: "Continuous vulnerability scanning",
    icon: PackageSearch,
  },
  {
    name: "Network Isolation",
    desc: "Per-agent network policy enforcement",
    icon: Network,
  },
  {
    name: "Capabilities",
    desc: "Fine-grained permission tokens per operation",
    icon: ScanEye,
  },
  {
    name: "Cert Pinning",
    desc: "TLS certificate validation for outbound requests",
    icon: FileKey,
  },
];

export default function Security() {
  return (
    <section id="security" className="py-24">
      <div className="max-w-6xl mx-auto px-6">
        <SectionHeader
          badge="SECURITY"
          title="18 Security Layers"
          subtitle="Fail-closed by default. Every operation denied unless explicitly allowed."
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {layers.map((layer, i) => {
            const Icon = layer.icon;
            return (
              <FadeIn key={layer.name} delay={i * 40}>
                <div className="bg-card border border-white/6 rounded-xl p-4 card-hover flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div>
                    <h3 className="font-mono text-sm font-semibold">
                      {layer.name}
                    </h3>
                    <p className="text-muted text-xs mt-0.5 leading-relaxed font-mono">
                      {layer.desc}
                    </p>
                  </div>
                </div>
              </FadeIn>
            );
          })}
        </div>
      </div>
    </section>
  );
}
