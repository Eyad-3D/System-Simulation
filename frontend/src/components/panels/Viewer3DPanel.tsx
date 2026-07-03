export function Viewer3DPanel() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#1d232c] text-[#8fa0b5]">
      <svg width="220" height="130" viewBox="0 0 220 130" fill="none">
        {/* wireframe aircraft placeholder */}
        <g stroke="#3d4d63" strokeWidth="1">
          {Array.from({ length: 9 }).map((_, i) => (
            <line key={`v${i}`} x1={20 + i * 22.5} y1={10} x2={20 + i * 22.5} y2={120} />
          ))}
          {Array.from({ length: 6 }).map((_, i) => (
            <line key={`h${i}`} x1={20} y1={10 + i * 22} x2={200} y2={10 + i * 22} />
          ))}
        </g>
        <g stroke="#6f8bb0" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
          <path d="M110 30 L118 62 L185 74 L185 82 L118 76 L114 100 L128 110 L128 115 L110 108 L92 115 L92 110 L106 100 L102 76 L35 82 L35 74 L102 62 Z" />
          <circle cx="70" cy="72" r="6" />
          <circle cx="150" cy="72" r="6" />
          <circle cx="48" cy="76" r="5" />
          <circle cx="172" cy="76" r="5" />
        </g>
      </svg>
      <div className="text-center">
        <div className="text-[13px] font-semibold text-[#b7c4d6]">3D Viewer</div>
        <div className="mt-1 max-w-[320px] text-[11.5px]">
          Not available in SimStudio v1 — this tab is a placeholder for a future
          CAD / geometry view of the modeled system.
        </div>
      </div>
    </div>
  );
}
