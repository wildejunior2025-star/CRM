import { useEffect, useRef, useState } from 'react'

// Senha de 6 números do link do cliente (mig 0175).
//
// Só aparece na hora de ENVIAR o pedido — nunca pra abrir a página. É o que
// deixa a senha ser quase obrigatória sem custar pedido: com o carrinho já
// montado, ninguém desiste por seis números. Senha na porta de entrada
// derrubaria o pedido por link, que hoje é a coisa mais fácil do sistema.
//
// Dois modos:
//   criar   → digita, confirma, pronto (duas telas, a segunda pra conferência)
//   digitar → seis bolinhas; cada número acende uma, e no sexto ENVIA SOZINHO
//
// Sem botão "confirmar" no modo digitar: o sexto número já é a confirmação.

const VAZIO = ''

// Teclado próprio em vez de <input type="number">: no Android o teclado do
// sistema abre com letras dependendo do aparelho, e o campo numérico aceita
// "e", "+" e "-". Aqui só existem os dez algarismos.
const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', '⌫']

function Bolinhas({ n, erro }) {
  return (
    <div style={{ display: 'flex', gap: 12, justifyContent: 'center', margin: '22px 0 6px' }}>
      {[0, 1, 2, 3, 4, 5].map(i => (
        <span key={i} style={{
          width: 16, height: 16, borderRadius: '50%',
          background: erro ? '#ef4444' : (i < n ? '#22c55e' : 'transparent'),
          border: `2px solid ${erro ? '#ef4444' : (i < n ? '#22c55e' : '#4c3f7a')}`,
          transition: 'background 120ms, border-color 120ms',
        }} />
      ))}
    </div>
  )
}

function Teclado({ onDigito, onApagar, desabilitado }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 18 }}>
      {TECLAS.map((t, i) => t === null ? <span key={i} /> : (
        <button
          key={i}
          type="button"
          disabled={desabilitado}
          onClick={() => t === '⌫' ? onApagar() : onDigito(t)}
          style={{
            height: 54, borderRadius: 12, cursor: desabilitado ? 'default' : 'pointer',
            border: '1px solid #3a2f63', background: t === '⌫' ? 'transparent' : '#241c47',
            color: '#fff', fontSize: t === '⌫' ? 20 : 22, fontWeight: 700,
            opacity: desabilitado ? .4 : 1,
          }}
        >{t}</button>
      ))}
    </div>
  )
}

export default function SenhaCliente({ modo, onCriar, onDigitar, onFechar, erro, ocupado }) {
  // modo: 'criar' | 'digitar'
  const [etapa, setEtapa]   = useState(modo === 'criar' ? 'aviso' : 'digitar')
  const [senha, setSenha]   = useState(VAZIO)
  const [primeira, setPrimeira] = useState(VAZIO)   // guarda a 1ª digitação no modo criar
  const [aviso, setAviso]   = useState(null)
  const enviado = useRef(false)

  // Erro que veio de fora (senha errada, link travado): limpa pra ele digitar
  // de novo, sem precisar apagar número por número.
  useEffect(() => { if (erro) { setSenha(VAZIO); enviado.current = false } }, [erro])

  function digitar(d) {
    if (ocupado || senha.length >= 6) return
    const nova = senha + d
    setSenha(nova)
    setAviso(null)
    if (nova.length === 6) completou(nova)
  }

  function apagar() {
    if (ocupado) return
    setSenha(s => s.slice(0, -1))
    setAviso(null)
  }

  function completou(valor) {
    if (enviado.current) return
    if (etapa === 'digitar') {
      // Sexto número já vale como confirmação: manda.
      enviado.current = true
      onDigitar(valor)
      return
    }
    if (etapa === 'criar1') {
      setPrimeira(valor); setSenha(VAZIO); setEtapa('criar2')
      return
    }
    // criar2: as duas têm que bater.
    if (valor !== primeira) {
      setAviso('As duas senhas não bateram. Vamos de novo.')
      setPrimeira(VAZIO); setSenha(VAZIO); setEtapa('criar1')
      return
    }
    enviado.current = true
    onCriar(valor)
  }

  const titulo = {
    aviso:  'Crie sua senha',
    criar1: 'Escolha 6 números',
    criar2: 'Digite de novo',
    digitar: 'Digite sua senha',
  }[etapa]

  const legenda = {
    aviso:  null,
    criar1: 'Anote num lugar seguro. Você vai usar sempre que pedir.',
    criar2: 'Só pra conferir se não escapou nenhum número.',
    digitar: 'Os mesmos 6 números que você criou.',
  }[etapa]

  return (
    <div
      onClick={onFechar}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 18 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 340, background: '#15102a', borderRadius: 18, padding: '24px 20px', color: '#fff' }}
      >
        {etapa === 'aviso' ? (
          <>
            <div style={{ fontSize: 34, textAlign: 'center', marginBottom: 10 }}>🔒</div>
            <h2 style={{ margin: '0 0 10px', fontSize: 19, textAlign: 'center' }}>Crie sua senha</h2>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: '#c4b5fd', textAlign: 'center', margin: '0 0 20px' }}>
              Seu link é só seu. A senha de 6 números garante que
              ninguém peça no seu nome se o link cair na mão de outra pessoa.
            </p>
            <button
              type="button"
              onClick={() => setEtapa('criar1')}
              style={{ width: '100%', height: 50, borderRadius: 12, border: 'none', cursor: 'pointer', background: '#7c3aed', color: '#fff', fontWeight: 800, fontSize: 15 }}
            >
              Criar minha senha
            </button>
            <button
              type="button"
              onClick={onFechar}
              style={{ width: '100%', marginTop: 8, height: 42, borderRadius: 12, border: 'none', background: 'transparent', color: '#8b7bb8', cursor: 'pointer', fontSize: 13.5 }}
            >
              Agora não
            </button>
          </>
        ) : (
          <>
            <h2 style={{ margin: '0 0 4px', fontSize: 18, textAlign: 'center' }}>{titulo}</h2>
            {legenda && (
              <p style={{ fontSize: 12.5, color: '#8b7bb8', textAlign: 'center', margin: 0 }}>{legenda}</p>
            )}

            <Bolinhas n={senha.length} erro={!!erro || !!aviso} />

            <div style={{ minHeight: 34, textAlign: 'center', fontSize: 12.5, color: '#f87171', padding: '4px 0' }}>
              {erro || aviso || (ocupado ? <span style={{ color: '#8b7bb8' }}>Enviando…</span> : '')}
            </div>

            <Teclado onDigito={digitar} onApagar={apagar} desabilitado={ocupado} />

            <button
              type="button"
              onClick={onFechar}
              style={{ width: '100%', marginTop: 12, height: 40, borderRadius: 12, border: 'none', background: 'transparent', color: '#8b7bb8', cursor: 'pointer', fontSize: 13.5 }}
            >
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  )
}
