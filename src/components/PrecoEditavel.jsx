import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// PREÇO EDITÁVEL NA PRÓPRIA LISTA (21/10/2026)
//
// Antes, trocar um preço era: Catálogo → achar o produto → Editar → mudar →
// Salvar. Cinco passos por item. Numa pastelaria tudo bem, o preço fica meses
// parado. Numa PEIXARIA a tabela muda toda semana com a pesca — na CL Pescados
// são 25 produtos, e o camarão P saiu de R$ 60 pra R$ 59 em uma semana. Com
// cinco passos por item ninguém atualiza, e aí o cardápio online passa a
// mentir o preço, que é pior do que não ter preço.
//
// Um componente só, usado no Catálogo do Portal E no cardápio do gestor: se
// cada tela tivesse a sua cópia, um dia uma aceitaria vírgula e a outra não.

// "59,90" e "59.90" têm que funcionar os dois: o lojista digita do jeito dele.
// Só que "1.234,56" tem ponto de MILHAR — por isso o ponto só é decimal quando
// não existe vírgula na frente.
function precoParaNumero(texto) {
  const limpo = String(texto ?? '').trim().replace(/[^\d.,]/g, '')
  if (!limpo) return NaN
  const normal = limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo
  return Number(normal)
}

export default function PrecoEditavel({
  id,                 // id do produto
  valor,              // preço atual
  onSalvo,            // (novoValor) => void — o pai acerta a lista dele
  podeEditar = true,
  campo = 'preco_venda',
  style = {},
}) {
  const [editando, setEditando] = useState(false)
  const [texto, setTexto] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const ref = useRef(null)
  // Enter já salvou: o blur que vem logo atrás não pode salvar de novo.
  const jaSalvou = useRef(false)

  useEffect(() => {
    if (editando && ref.current) { ref.current.focus(); ref.current.select() }
  }, [editando])

  const formatado = `R$ ${Number(valor || 0).toFixed(2)}`

  function abrir() {
    if (!podeEditar || salvando) return
    setErro(null)
    jaSalvou.current = false
    // Abre com o valor atual já digitado: na maioria das vezes muda só o
    // centavo, e redigitar tudo é o que fazia a pessoa desistir.
    setTexto(String(Number(valor || 0).toFixed(2)).replace('.', ','))
    setEditando(true)
  }

  async function salvar() {
    if (jaSalvou.current) return
    jaSalvou.current = true

    const novo = precoParaNumero(texto)
    if (!Number.isFinite(novo) || novo <= 0) {
      setErro('Valor inválido')
      jaSalvou.current = false
      if (ref.current) { ref.current.focus(); ref.current.select() }
      return
    }
    // Não mudou nada: fecha sem ir ao banco.
    if (Math.abs(novo - Number(valor || 0)) < 0.005) { setEditando(false); return }

    setSalvando(true)
    const { error } = await supabase.from('produtos').update({ [campo]: novo }).eq('id', id)
    setSalvando(false)

    if (error) {
      setErro(error.message)
      jaSalvou.current = false
      return
    }
    setEditando(false)
    onSalvo?.(novo)
  }

  if (!editando) {
    return (
      <span
        onClick={abrir}
        role={podeEditar ? 'button' : undefined}
        tabIndex={podeEditar ? 0 : undefined}
        onKeyDown={(e) => {
          if (!podeEditar) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir() }
        }}
        title={podeEditar ? 'Clique para mudar o preço' : undefined}
        style={{
          cursor: podeEditar ? 'pointer' : 'default',
          ...(podeEditar ? {
            // A PISTA TEM QUE SER VISÍVEL.
            //
            // A 1ª versão usava tracejado em `var(--border)`, que é cinza —
            // sobre o preço cinza de 12px do cardápio do gestor sumia por
            // completo, e o dono abriu a tela sem descobrir que dava pra
            // clicar. Recurso que ninguém vê não existe.
            //
            // Agora vai na cor do sistema, em negrito, com o tracejado da
            // mesma cor e um lápis pequeno. Chama sem virar botão: numa lista
            // de 25 produtos, 25 botões viram uma parede.
            color: 'var(--primary, #7c3aed)',
            fontWeight: 700,
            borderBottom: '1px dashed var(--primary, #7c3aed)',
            whiteSpace: 'nowrap',
          } : null),
          ...style,
        }}
      >
        {formatado}
        {podeEditar && (
          <span aria-hidden="true" style={{ fontSize: '0.85em', marginLeft: 4, opacity: 0.75 }}>✏️</span>
        )}
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>R$</span>
      <input
        ref={ref}
        value={texto}
        inputMode="decimal"
        disabled={salvando}
        onChange={(e) => { setTexto(e.target.value); setErro(null) }}
        onBlur={salvar}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); salvar() }
          // Esc desiste: fecha sem gravar e sem o blur salvar por tabela.
          if (e.key === 'Escape') { jaSalvou.current = true; setEditando(false); setErro(null) }
        }}
        style={{
          width: 78, padding: '3px 6px', borderRadius: 6, font: 'inherit',
          border: `1px solid ${erro ? 'var(--danger, #ef4444)' : 'var(--primary, #7c3aed)'}`,
          background: 'var(--card)', color: 'var(--text)',
        }}
      />
      {salvando && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>salvando…</span>}
      {erro && <span style={{ fontSize: 11, color: 'var(--danger, #ef4444)' }}>{erro}</span>}
    </span>
  )
}
