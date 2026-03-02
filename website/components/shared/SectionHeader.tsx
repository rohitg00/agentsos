import FadeIn from "./FadeIn";

export default function SectionHeader({
  badge,
  title,
  subtitle,
}: {
  badge: string;
  title: string;
  subtitle?: string;
  badgeColor?: string;
}) {
  return (
    <FadeIn className="text-center mb-12">
      <span className="inline-block px-3 py-1 rounded-full text-xs font-mono font-medium bg-primary/10 text-primary mb-4">
        {badge}
      </span>
      <h2 className="text-3xl md:text-4xl font-bold font-mono mb-3">{title}</h2>
      {subtitle && <p className="text-muted max-w-2xl mx-auto font-mono text-sm">{subtitle}</p>}
    </FadeIn>
  );
}
