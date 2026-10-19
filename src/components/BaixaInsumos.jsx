import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// ENTRADA e BAIXA de INSUMO (hambúrguer, carne, queijo...) pelo gestor — migs
// 0331 (baixa) e 0350 (entrada).
//
// Quem está na loja mexe nos dois sentidos, do mesmo lugar:
//
//   BAIXA   → o que se perdeu ("caiu no chão, joguei fora"). Vai pela função
//             imprevisto_registrar_mp, que EXIGE o motivo, tira do estoque e
//             lança o prejuízo nos custos imprevistos do dia.
//   ENTRADA → o que chegou do fornecedor. Só soma; o preço pago é opcional.
//
// Os dois carimbam quem fez e quando, e viram linha em materia_prima_movimentos
// — é de lá que o Portal monta o histórico (Ficha Técnica → Histórico).

const brl = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`
const qtdTxt = (v, un) => `${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${un}`

export default function BaixaInsumos() {
  const [insumos, setInsumos] = useState([])
  const [aberto, setAberto] = useState(false)       // seção recolhida por padrão
  const [baixaId, setBaixaId] = useState(null)      // insumo com o formulário aberto
  const [modo, setModo] = useState('baixa')         // 'baixa' | 'entrada'
  const [qtd, setQtd] = useState('1')
  const [motivo, setMotivo] = useState('')
  const [pago, setPago] = useState('')              // quanto custou a compra (opcional)
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [ok, setOk] = useState(null)

  const carregar = useCallback(async () => {
    try {
      const { data } = await supabase.from('materia_prima_saldo')
        .select('materia_prima_id, nome, unidade, custo, quantidade_atual').order('nome')
      setInsumos(data ?? [])
    } catch { /* sem a lista a seção só não aparece */ }
  }, [])

  useEffect(() => { carregar() }, [carregar])

  if (!insumos.length) return null

  async function darBaixa(m) {
    const q = Number(String(qtd).replace(',', '.'))
    if (!Number.isFinite(q) || q <= 0) { setErro('Diga quantos se perderam.'); return }
    if (!motivo.trim()) { setErro('Descreva o que aconteceu.'); return }
    setSalvando(true); setErro(null)
    const { error } = await supabase.rpc('imprevisto_registrar_mp', {
      p_materia_prima_id: m.materia_prima_id, p_quantidade: q, p_descricao: motivo.trim(),
    })
    setSalvando(false)
    if (error) { setErro(error.message || 'Não deu pra registrar a baixa.'); return }
    setOk({ id: m.materia_prima_id, texto: `Baixa registrada — ${brl(q * Number(m.custo || 0))} no Financeiro de hoje.` })
    setBaixaId(null); setQtd('1'); setMotivo('')
    carregar()
    setTimeout(() => setOk(null), 6000)
  }

  async function darEntrada(m) {
    const q = Number(String(qtd).replace(',', '.'))
    if (!Number.isFinite(q) || q <= 0) { setErro('Diga quantos chegaram.'); return }
    const total = Number(String(pago).replace(',', '.'))
    const temPago = Number.isFinite(total) && total > 0
    setSalvando(true); setErro(null)
    const { data: perfil } = await supabase.auth.getUser()
    const { error } = await supabase.from('materia_prima_movimentos').insert({
      materia_prima_id: m.materia_prima_id, tipo: 'entrada', quantidade: q,
      // Preço é opcional: quem está no balcão nem sempre tem a nota na mão.
      custo_unit: temPago ? total / q : null,
      valor_total: temPago ? total : null,
      observacao: motivo.trim() || null,
      created_by: perfil?.user?.id ?? null,
    })
    setSalvando(false)
    if (error) { setErro(error.message || 'Não deu pra registrar a entrada.'); return }
    setOk({
      id: m.materia_prima_id,
      texto: `Entrada registrada — ${qtdTxt(q, m.unidade)}${temPago ? ` por ${brl(total)}` : ''}.`,
    })
    setBaixaId(null); setQtd('1'); setMotivo(''); setPago('')
    carregar()
    setTimeout(() => setOk(null), 6000)
  }

  const caixa = { border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)', borderRadius: 8, fontSize: 13 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button type="button" onClick={() => setAberto(a => !a)} aria-expanded={aberto}
        style={{ ...caixa, padding: '9px 12px', textAlign: 'left', fontWeight: 800, cursor: 'pointer' }}>
        🥩 Insumos (hambúrguer, carne…) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>· chegou ou se perdeu? lance aqui</span>
      </button>
      {aberto && insumos.map(m => (
        <div key={m.materia_prima_id} style={{ ...caixa, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{m.nome}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>tem {qtdTxt(m.quantidade_atual, m.unidade)}</div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              {/* Verde soma, laranja tira - a cor diz o sentido antes de ler. */}
              <button type="button"
                onClick={() => {
                  const mesmo = baixaId === m.materia_prima_id && modo === 'entrada'
                  setBaixaId(mesmo ? null : m.materia_prima_id); setModo('entrada')
                  setErro(null); setQtd('1'); setMotivo(''); setPago('')
                }}
                style={{ padding: '6px 12px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: 'pointer',
                  border: '1.5px solid #16a34a', background: 'rgba(22,163,74,.12)', color: '#16a34a' }}>
                Entrada
              </button>
              <button type="button"
                onClick={() => {
                  const mesmo = baixaId === m.materia_prima_id && modo === 'baixa'
                  setBaixaId(mesmo ? null : m.materia_prima_id); setModo('baixa')
                  setErro(null); setQtd('1'); setMotivo(''); setPago('')
                }}
                style={{ padding: '6px 12px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: 'pointer',
                  border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.12)', color: '#f59e0b' }}>
                Baixa
              </button>
            </div>
          </div>
          {baixaId === m.materia_prima_id && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {modo === 'entrada' ? `Chegaram quantos (${m.unidade})?` : `Perdeu quantos (${m.unidade})?`}
                </span>
                <input type="number" inputMode="decimal" min="0" step="any" value={qtd} onChange={e => setQtd(e.target.value)}
                  style={{ ...caixa, width: 70, padding: '6px 8px' }} />
                {modo === 'entrada'
                  ? <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      fica com {qtdTxt((Number(m.quantidade_atual) || 0) + (Number(String(qtd).replace(',', '.')) || 0), m.unidade)}
                    </span>
                  : <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                      {brl((Number(String(qtd).replace(',', '.')) || 0) * Number(m.custo || 0))} de prejuízo
                    </span>}
              </div>
              {modo === 'entrada' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Pagou quanto? (opcional)</span>
                  <input type="number" inputMode="decimal" min="0" step="any" value={pago} onChange={e => setPago(e.target.value)}
                    placeholder="R$" style={{ ...caixa, width: 90, padding: '6px 8px' }} />
                </div>
              )}
              <input type="text" autoFocus value={motivo} onChange={e => setMotivo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (modo === 'entrada' ? darEntrada(m) : darBaixa(m)) }}
                placeholder={modo === 'entrada'
                  ? 'De onde veio? (opcional — fornecedor, nota…)'
                  : 'O que aconteceu? (caiu no chão, joguei fora…)'}
                style={{ ...caixa, width: '100%', padding: '7px 10px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => (modo === 'entrada' ? darEntrada(m) : darBaixa(m))} disabled={salvando}
                  style={{ padding: '6px 14px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: salvando ? 'wait' : 'pointer',
                    border: `1.5px solid ${modo === 'entrada' ? '#16a34a' : '#f59e0b'}`,
                    background: modo === 'entrada' ? 'rgba(22,163,74,.18)' : 'rgba(245,158,11,.18)',
                    color: modo === 'entrada' ? '#16a34a' : '#f59e0b' }}>
                  {salvando ? '...' : (modo === 'entrada' ? 'Dar entrada' : 'Dar baixa')}
                </button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {modo === 'entrada'
                    ? 'fica registrado com o seu nome e a hora, e aparece no histórico do Portal'
                    : 'fica registrado com o seu nome e a hora, e vai pro Financeiro de hoje'}
                </span>
              </div>
              {erro && <div style={{ fontSize: 11.5, color: '#dc2626', fontWeight: 600 }}>{erro}</div>}
            </div>
          )}
          {ok?.id === m.materia_prima_id && (
            <div style={{ fontSize: 12, fontWeight: 700, color: '#16a34a' }}>✓ {ok.texto}</div>
          )}
        </div>
      ))}
    </div>
  )
}
