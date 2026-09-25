// ============================================================================
// Botão "voltar" do celular fecha o que está aberto na tela.
//
// A mesa do Salão (e os modais dentro dela) abrem por cima da página, sem
// mudar de endereço. Pro Android não existia "tela anterior": o garçom abria a
// mesa, apertava voltar e SAÍA do sistema (no Chrome e no app FWC Gestor).
//
// Cada coisa aberta ganha uma entrada falsa no histórico. O voltar consome a
// entrada de cima e fecha só ela — item → mesa → aí sim sai. Fechou pelo botão
// da tela? A entrada sobrando é tirada do histórico pra não precisar apertar
// voltar duas vezes depois.
// ============================================================================
import { useEffect, useRef } from 'react'

const pilha = []       // o que está aberto, na ordem em que abriu
let entradas = 0       // entradas nossas no topo do histórico
let ignorar = 0        // popstate causado por nós mesmos (limpeza)
let ouvindo = false

function aoVoltar() {
  if (ignorar > 0) { ignorar--; return }
  if (entradas > 0) entradas--
  const topo = pilha.pop()
  if (topo) { topo.porVoltar = true; topo.fechar() }
}

// Depois de fechar pela tela: tira do histórico as entradas que sobraram.
// Se o usuário já foi pra outra página (a entrada de cima não é nossa), não
// mexe — voltar ali levaria ele pra trás sem ele pedir.
let agendado = false
function sincronizar() {
  if (agendado) return
  agendado = true
  setTimeout(() => {
    agendado = false
    const sobrando = entradas - pilha.length
    if (sobrando <= 0) return
    if (!window.history.state?.fwcVoltar) { entradas = pilha.length; return }
    entradas -= sobrando
    ignorar++
    window.history.go(-sobrando)
  }, 0)
}

export function useVoltarFecha(aberto, fechar) {
  const fecharRef = useRef(fechar)
  useEffect(() => { fecharRef.current = fechar })

  useEffect(() => {
    if (!aberto || typeof window === 'undefined') return
    if (!ouvindo) { window.addEventListener('popstate', aoVoltar); ouvindo = true }
    const item = { fechar: () => fecharRef.current?.(), porVoltar: false }
    pilha.push(item)
    // Mantém o estado do react-router (usr/key/idx) — só marca a entrada.
    window.history.pushState({ ...(window.history.state || {}), fwcVoltar: true }, '')
    entradas++
    return () => {
      const i = pilha.indexOf(item)
      if (i >= 0) pilha.splice(i, 1)
      if (!item.porVoltar) sincronizar()
    }
  }, [aberto])
}
