import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// Baixa de INSUMO (hambúrguer, carne, queijo...) pelo gestor — mig 0331.
//
// Quem está na loja (vendedor, sem o dono) lança o que se perdeu: "caiu no chão,
// joguei fora". O estoque do insumo é só do dono; esta tela chama a função
// imprevisto_registrar_mp, que EXIGE o motivo, tira do estoque, lança o prejuízo
// nos custos imprevistos do dia e carimba quem fez e quando.

const brl = v => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`
const qtdTxt = (v, un) => `${Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${un}`

export default function BaixaInsumos() {
  const [insumos, setInsumos] = useState([])
  const [aberto, setAberto] = useState(false)       // seção recolhida por padrão
  const [baixaId, setBaixaId] = useState(null)      // insumo com o formulário aberto
  const [qtd, setQtd] = useState('1')
  const [motivo, setMotivo] = useState('')
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

  const caixa = { border: '1px solid var(--border, #2a2a3a)', background: 'var(--bg, #0f0f1a)', color: 'var(--text)', borderRadius: 8, fontSize: 13 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button type="button" onClick={() => setAberto(a => !a)} aria-expanded={aberto}
        style={{ ...caixa, padding: '9px 12px', textAlign: 'left', fontWeight: 800, cursor: 'pointer' }}>
        🥩 Insumos (hambúrguer, carne…) <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 12 }}>· perdeu algum? dê baixa aqui</span>
      </button>
      {aberto && insumos.map(m => (
        <div key={m.materia_prima_id} style={{ ...caixa, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700 }}>{m.nome}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>tem {qtdTxt(m.quantidade_atual, m.unidade)}</div>
            </div>
            <button type="button" onClick={() => { setBaixaId(baixaId === m.materia_prima_id ? null : m.materia_prima_id); setErro(null) }}
              style={{ padding: '6px 12px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: 'pointer',
                border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.12)', color: '#f59e0b' }}>
              Baixa
            </button>
          </div>
          {baixaId === m.materia_prima_id && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Perdeu quantos ({m.unidade})?</span>
                <input type="number" inputMode="decimal" min="0" step="any" value={qtd} onChange={e => setQtd(e.target.value)}
                  style={{ ...caixa, width: 70, padding: '6px 8px' }} />
                <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                  {brl((Number(String(qtd).replace(',', '.')) || 0) * Number(m.custo || 0))} de prejuízo
                </span>
              </div>
              <input type="text" autoFocus value={motivo} onChange={e => setMotivo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') darBaixa(m) }}
                placeholder="O que aconteceu? (caiu no chão, joguei fora…)"
                style={{ ...caixa, width: '100%', padding: '7px 10px' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => darBaixa(m)} disabled={salvando}
                  style={{ padding: '6px 14px', borderRadius: 8, fontWeight: 800, fontSize: 12, cursor: salvando ? 'wait' : 'pointer',
                    border: '1.5px solid #f59e0b', background: 'rgba(245,158,11,.18)', color: '#f59e0b' }}>
                  {salvando ? '...' : 'Dar baixa'}
                </button>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>fica registrado com o seu nome e a hora, e vai pro Financeiro de hoje</span>
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
