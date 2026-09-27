// Kax, la mascota del Asistente — mismo diseño que en Kaxa Móvil (gota/gema
// verde de la marca con una "K" en el pecho). La pose cambia según los
// consejos: "alerta" si hay algo urgente, "celebrando" si todo va bien,
// "neutral" para un período normal.
export type PoseKax = "neutral" | "alerta" | "celebrando";

export default function KaxMascota({ pose, size = 72 }: { pose: PoseKax; size?: number }) {
  return (
    <svg viewBox="-30 -30 280 300" width={size} height={size * 1.07} aria-hidden="true">
      <defs>
        <linearGradient id="kaxBody" x1="0%" y1="0%" x2="20%" y2="100%">
          <stop offset="0%" stopColor="#16A37C" />
          <stop offset="100%" stopColor="#0B4F3D" />
        </linearGradient>
      </defs>
      <ellipse cx="110" cy="248" rx="70" ry="12" fill="#083F31" opacity="0.12" />

      {pose === "neutral" && (
        <>
          <rect x="14" y="128" width="26" height="72" rx="13" fill="url(#kaxBody)" transform="rotate(18 27 128)" />
          <rect x="178" y="70" width="24" height="66" rx="12" fill="url(#kaxBody)" transform="rotate(-100 190 96)" />
          <path
            d="M110,18 C156,18 191,54 194,104 C197,154 179,204 146,224 C126,236 94,236 74,224 C41,204 23,154 26,104 C29,54 64,18 110,18 Z"
            fill="url(#kaxBody)"
          />
          <circle cx="110" cy="158" r="26" fill="#EAF6F1" />
          <text x="110" y="169" fontSize="28" fontWeight="800" textAnchor="middle" fill="#0F6E56">
            K
          </text>
          <circle cx="83" cy="96" r="19" fill="#ffffff" />
          <circle cx="137" cy="96" r="19" fill="#ffffff" />
          <circle cx="87" cy="99" r="8.5" fill="#0B241D" />
          <circle cx="141" cy="99" r="8.5" fill="#0B241D" />
          <circle cx="90" cy="95" r="2.4" fill="#ffffff" />
          <circle cx="144" cy="95" r="2.4" fill="#ffffff" />
          <path d="M92,120 Q110,134 128,120" stroke="#0B241D" strokeWidth="4" fill="none" strokeLinecap="round" />
        </>
      )}

      {pose === "alerta" && (
        <>
          <circle cx="200" cy="30" r="17" fill="#C9820B" />
          <rect x="196" y="20" width="8" height="14" rx="4" fill="#ffffff" />
          <circle cx="200" cy="40" r="3" fill="#ffffff" />
          <rect x="18" y="130" width="24" height="58" rx="12" fill="url(#kaxBody)" transform="rotate(30 30 130)" />
          <rect x="172" y="90" width="24" height="80" rx="12" fill="url(#kaxBody)" transform="rotate(-35 184 90)" />
          <g transform="rotate(-4 110 130)">
            <path
              d="M110,18 C156,18 191,54 194,104 C197,154 179,204 146,224 C126,236 94,236 74,224 C41,204 23,154 26,104 C29,54 64,18 110,18 Z"
              fill="url(#kaxBody)"
            />
            <circle cx="110" cy="158" r="26" fill="#EAF6F1" />
            <text x="110" y="169" fontSize="28" fontWeight="800" textAnchor="middle" fill="#0F6E56">
              K
            </text>
            <rect x="68" y="70" width="26" height="5" rx="2.5" fill="#0B241D" transform="rotate(14 81 72)" />
            <rect x="126" y="70" width="26" height="5" rx="2.5" fill="#0B241D" transform="rotate(-14 139 72)" />
            <circle cx="83" cy="96" r="17" fill="#ffffff" />
            <circle cx="137" cy="96" r="17" fill="#ffffff" />
            <circle cx="83" cy="99" r="8" fill="#0B241D" />
            <circle cx="137" cy="99" r="8" fill="#0B241D" />
            <rect x="96" y="122" width="28" height="4.5" rx="2.2" fill="#0B241D" />
          </g>
        </>
      )}

      {pose === "celebrando" && (
        <>
          <circle cx="20" cy="40" r="5" fill="#C9820B" />
          <circle cx="45" cy="10" r="4" fill="#EC4899" />
          <circle cx="185" cy="20" r="5" fill="#3B82F6" />
          <circle cx="205" cy="55" r="4" fill="#C9820B" />
          <rect x="30" y="60" width="8" height="8" fill="#16A37C" transform="rotate(20 34 64)" />
          <rect x="195" y="90" width="8" height="8" fill="#EC4899" transform="rotate(-15 199 94)" />
          <rect x="8" y="20" width="24" height="76" rx="12" fill="url(#kaxBody)" transform="rotate(35 20 96)" />
          <rect x="188" y="20" width="24" height="76" rx="12" fill="url(#kaxBody)" transform="rotate(-35 200 96)" />
          <path
            d="M110,18 C156,18 191,54 194,104 C197,154 179,204 146,224 C126,236 94,236 74,224 C41,204 23,154 26,104 C29,54 64,18 110,18 Z"
            fill="url(#kaxBody)"
          />
          <circle cx="110" cy="158" r="26" fill="#EAF6F1" />
          <text x="110" y="169" fontSize="28" fontWeight="800" textAnchor="middle" fill="#0F6E56">
            K
          </text>
          <circle cx="83" cy="96" r="19" fill="#ffffff" />
          <circle cx="87" cy="99" r="8.5" fill="#0B241D" />
          <circle cx="90" cy="95" r="2.4" fill="#ffffff" />
          <path d="M126,98 Q137,88 148,98" stroke="#0B241D" strokeWidth="4.5" fill="none" strokeLinecap="round" />
          <path d="M86,116 Q110,142 134,116" stroke="#0B241D" strokeWidth="5" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
