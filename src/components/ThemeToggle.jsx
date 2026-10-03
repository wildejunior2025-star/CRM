import './ThemeToggle.css'

// O botão diz o que ele FAZ, não a cor que a tela já está.
//
// Antes o texto mostrava o estado ("Modo claro" com a tela clara) enquanto o
// tooltip do mesmo botão mostrava a ação ("Ativar modo escuro") — os dois se
// contradiziam. Passava batido porque quase todo mundo abria no escuro; depois
// que o sistema passou a abrir claro pra todo mundo, virou um botão que parece
// não fazer nada. Agora texto, desenho e tooltip falam a mesma coisa: na tela
// clara aparece a lua e "Modo escuro", que é pra onde o clique leva.
export default function ThemeToggle({ theme, onToggle }) {
  const isDark = theme === 'dark'
  const acao = isDark ? 'Modo claro' : 'Modo escuro'

  const sol = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
  const lua = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6.364 6.364 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  )

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`Ativar ${acao.toLowerCase()}`}
      title={acao}
    >
      <span className={`theme-toggle-icon ${isDark ? 'is-dark' : 'is-light'}`}>
        {isDark ? sol : lua}
      </span>
      <span className="theme-toggle-label">{acao}</span>
    </button>
  )
}
