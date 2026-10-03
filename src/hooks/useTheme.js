import { useEffect, useState } from 'react'

const STORAGE_KEY = 'crm-theme'

// O sistema abre CLARO pra todo mundo, em qualquer aparelho.
//
// Antes ele copiava o tema do celular (prefers-color-scheme), e aí o mesmo
// sistema tinha duas caras: o lojista de celular no modo escuro via uma tela,
// a gente via outra, e explicar qualquer coisa por telefone ("clica no botão
// branco lá em cima") virava adivinhação.
//
// Escuro continua existindo — só deixou de ser automático. Quem clicar no
// botão fica no escuro PRA SEMPRE naquele aparelho, até clicar de volta: a
// escolha é guardada e nada aqui a desfaz.
//
// A troca de uma vez só (crm-theme-v2) mora no index.html, que roda antes do
// React pra tela não piscar. Aqui a gente só lê o que ele deixou.
function getInitialTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function useTheme() {
  const [theme, setTheme] = useState(getInitialTheme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try { localStorage.setItem(STORAGE_KEY, theme) } catch { /* ignora */ }
  }, [theme])

  function toggleTheme() {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))
  }

  return { theme, toggleTheme }
}
