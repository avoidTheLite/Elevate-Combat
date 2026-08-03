interface Props {
  log: string[];
}

export function CombatLog({ log }: Props) {
  return (
    <div className="border border-[#002233] p-3 font-mono text-xs h-48 overflow-y-auto space-y-0">
      <div className="text-[#006677] mb-1">// COMBAT LOG</div>
      {log.length === 0 ? (
        <div className="text-[#003344]">No engagements yet.</div>
      ) : (
        log.map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith("---")
                ? "text-[#005566] mt-1"
                : line.includes("DIRECT HIT")
                ? "text-[#ffaa00]"
                : line.includes("SPLASH HIT")
                ? "text-[#88cc00]"
                : line.includes("MISS") || line.includes("DEAD") || line.includes("ZONE")
                ? "text-[#ff4455]"
                : line.includes("damage")
                ? "text-[#00ffcc]"
                : "text-[#004455]"
            }
          >
            {line || "\u00a0"}
          </div>
        ))
      )}
    </div>
  );
}
