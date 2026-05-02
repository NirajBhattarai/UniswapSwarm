/**
 * SwarmLogo — inline SVG icon for the UniswapSwarm app (v2: glow + dark background).
 *
 * 6 agent nodes (Re/Pl/Ri/St/Cr/Ex) in a hexagonal ring connected to a central
 * hub (swap arrows), all on a dark deep-space background with per-node glow halos.
 *
 * Usage:
 *   <SwarmLogo size={36} />
 *   <SwarmLogo size={24} className="opacity-80" />
 */
export function SwarmLogo({
  size = 36,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="UniswapSwarm"
      className={className}
    >
      <defs>
        <filter id="sw-g-xl" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
        <filter id="sw-g-lg" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <filter id="sw-g-md" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
        <radialGradient id="sw-bg" cx="42%" cy="38%" r="65%">
          <stop offset="0%" stopColor="#1e1245" />
          <stop offset="55%" stopColor="#0f1330" />
          <stop offset="100%" stopColor="#07091a" />
        </radialGradient>
        <linearGradient id="sw-hub" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#A78BFA" />
          <stop offset="55%" stopColor="#8B5CF6" />
          <stop offset="100%" stopColor="#4338CA" />
        </linearGradient>
        <linearGradient id="sw-hub-hl" x1="0" y1="0" x2="0.2" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.28" />
          <stop offset="45%" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sw-n0" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#67E8F9" />
          <stop offset="100%" stopColor="#0284C7" />
        </linearGradient>
        <linearGradient id="sw-n1" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#C084FC" />
          <stop offset="100%" stopColor="#7C3AED" />
        </linearGradient>
        <linearGradient id="sw-n2" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#FB7185" />
          <stop offset="100%" stopColor="#BE123C" />
        </linearGradient>
        <linearGradient id="sw-n3" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#4ADE80" />
          <stop offset="100%" stopColor="#166534" />
        </linearGradient>
        <linearGradient id="sw-n4" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#FCD34D" />
          <stop offset="100%" stopColor="#B45309" />
        </linearGradient>
        <linearGradient id="sw-n5" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor="#93C5FD" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
        <radialGradient id="sw-nhl" cx="35%" cy="25%" r="60%">
          <stop offset="0%" stopColor="white" stopOpacity="0.38" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <clipPath id="sw-clip">
          <rect width="200" height="200" rx="44" />
        </clipPath>
      </defs>

      <g clipPath="url(#sw-clip)">
        {/* Background */}
        <rect width="200" height="200" fill="url(#sw-bg)" />
        <circle
          cx="100"
          cy="100"
          r="58"
          fill="#6D28D9"
          opacity="0.22"
          filter="url(#sw-g-xl)"
        />
        <ellipse
          cx="82"
          cy="65"
          rx="45"
          ry="40"
          fill="#4F46E5"
          opacity="0.1"
          filter="url(#sw-g-lg)"
        />

        {/* Outer dashed guide ring */}
        <polygon
          points="188,100 144,176 56,176 12,100 56,24 144,24"
          fill="none"
          stroke="#6D28D9"
          strokeWidth="0.9"
          strokeOpacity="0.4"
          strokeDasharray="5 5"
        />

        {/* Ring between adjacent nodes */}
        <g fill="none" stroke="#818CF8" strokeWidth="0.85" strokeOpacity="0.3">
          <line x1="100" y1="35" x2="156" y2="68" />
          <line x1="156" y1="68" x2="156" y2="132" />
          <line x1="156" y1="132" x2="100" y2="165" />
          <line x1="100" y1="165" x2="44" y2="132" />
          <line x1="44" y1="132" x2="44" y2="68" />
          <line x1="44" y1="68" x2="100" y2="35" />
        </g>

        {/* Spokes hub → nodes */}
        <g fill="none" stroke="#C4B5FD" strokeWidth="1.1" strokeOpacity="0.32">
          <line x1="100" y1="100" x2="100" y2="35" />
          <line x1="100" y1="100" x2="156" y2="68" />
          <line x1="100" y1="100" x2="156" y2="132" />
          <line x1="100" y1="100" x2="100" y2="165" />
          <line x1="100" y1="100" x2="44" y2="132" />
          <line x1="100" y1="100" x2="44" y2="68" />
        </g>

        {/* Hub glow → body → glass → rim */}
        <polygon
          points="130,100 115,126 85,126 70,100 85,74 115,74"
          fill="#8B5CF6"
          opacity="0.55"
          filter="url(#sw-g-xl)"
        />
        <polygon
          points="130,100 115,126 85,126 70,100 85,74 115,74"
          fill="url(#sw-hub)"
        />
        <polygon
          points="130,100 115,126 85,126 70,100 85,74 115,74"
          fill="url(#sw-hub-hl)"
          opacity="0.85"
        />
        <polygon
          points="130,100 115,126 85,126 70,100 85,74 115,74"
          fill="none"
          stroke="white"
          strokeWidth="0.7"
          strokeOpacity="0.2"
        />

        {/* Swap arrows */}
        <line
          x1="82"
          y1="92"
          x2="110"
          y2="92"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeOpacity="0.9"
        />
        <polyline
          points="106,86.5 112,92 106,97.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity="0.9"
        />
        <line
          x1="118"
          y1="108"
          x2="90"
          y2="108"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeOpacity="0.9"
        />
        <polyline
          points="94,102.5 88,108 94,113.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity="0.9"
        />

        {/* Node halos */}
        <circle
          cx="100"
          cy="35"
          r="21"
          fill="#22D3EE"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />
        <circle
          cx="156"
          cy="68"
          r="21"
          fill="#A855F7"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />
        <circle
          cx="156"
          cy="132"
          r="21"
          fill="#F43F5E"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />
        <circle
          cx="100"
          cy="165"
          r="21"
          fill="#22C55E"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />
        <circle
          cx="44"
          cy="132"
          r="21"
          fill="#F59E0B"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />
        <circle
          cx="44"
          cy="68"
          r="21"
          fill="#3B82F6"
          opacity="0.3"
          filter="url(#sw-g-md)"
        />

        {/* Researcher — cyan */}
        <circle cx="100" cy="35" r="14" fill="url(#sw-n0)" />
        <circle cx="100" cy="35" r="14" fill="url(#sw-nhl)" />
        <text
          x="100"
          y="35"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          Re
        </text>

        {/* Planner — violet */}
        <circle cx="156" cy="68" r="14" fill="url(#sw-n1)" />
        <circle cx="156" cy="68" r="14" fill="url(#sw-nhl)" />
        <text
          x="156"
          y="68"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          Pl
        </text>

        {/* Risk — rose */}
        <circle cx="156" cy="132" r="14" fill="url(#sw-n2)" />
        <circle cx="156" cy="132" r="14" fill="url(#sw-nhl)" />
        <text
          x="156"
          y="132"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          Ri
        </text>

        {/* Strategy — emerald */}
        <circle cx="100" cy="165" r="14" fill="url(#sw-n3)" />
        <circle cx="100" cy="165" r="14" fill="url(#sw-nhl)" />
        <text
          x="100"
          y="165"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          St
        </text>

        {/* Critic — amber */}
        <circle cx="44" cy="132" r="14" fill="url(#sw-n4)" />
        <circle cx="44" cy="132" r="14" fill="url(#sw-nhl)" />
        <text
          x="44"
          y="132"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          Cr
        </text>

        {/* Executor — blue */}
        <circle cx="44" cy="68" r="14" fill="url(#sw-n5)" />
        <circle cx="44" cy="68" r="14" fill="url(#sw-nhl)" />
        <text
          x="44"
          y="68"
          textAnchor="middle"
          dominantBaseline="central"
          fill="white"
          fontSize="7.5"
          fontWeight="800"
          fontFamily="system-ui,sans-serif"
        >
          Ex
        </text>
      </g>
    </svg>
  );
}
