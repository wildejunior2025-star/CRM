// Ícone do iFood (SVG inline) — círculo vermelho com os dois olhos e o sorriso-seta.
// Aproximação da marca pra identificar o canal iFood no painel do lojista.
export default function IfoodIcon({ size = 24, style }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="iFood"
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}>
      <circle cx="50" cy="50" r="50" fill="#EA1D2C" />
      {/* olhos */}
      <ellipse cx="37" cy="42" rx="8.5" ry="12.5" fill="#fff" transform="rotate(18 37 42)" />
      <ellipse cx="62" cy="38" rx="9.5" ry="13.5" fill="#fff" transform="rotate(18 62 38)" />
      {/* sorriso */}
      <path d="M24 55 C 36 73, 58 75, 69 59" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" />
      {/* seta na ponta do sorriso */}
      <path d="M61 62 L 75 55 L 70 71 Z" fill="#fff" />
    </svg>
  )
}
