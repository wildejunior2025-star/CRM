import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

// O dono edita a taxa da corrida do motoboy direto no gestor, sem depender do motoboy (mig 0346).
// Mostra o que o sistema calcula (tabela de km da loja) e deixa voltar pra esse valor num toque.
// Corrida já paga não muda: o banco recusa e a mensagem aparece aqui.
const fmt = v => `R$ ${Number(v ?? 0).toFixed(2).replace('.', ',')}`

export default function ModalTaxaMotoboy({ pedido, onFechar, onSalvo }) {
  const atual = pedido.valor_entregador != null ? Number(pedido.valor_entregador) : null
  const [sugerido, setSugerido] = useState(null)
  const [carregandoSug, setCarregandoSug] = useState(true)
  const [txt, setTxt] = useState(atual != null ? String(atual).replace('.', ',') : '')
  const [erro, setErro] = useState(null)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => {
    let vivo = true
    supabase.rpc('entregador_valor_sugerido', { p_pedido: pedido.id }).then(({ data }) => {
      if (!vivo) return
      setCarregandoSug(false)
      if (data != null) {
        setSugerido(Number(data))
        // Corrida sem valor ainda: já abre com o que o sistema calcula.
        setTxt(t => (t === '' ? String(Number(data)).replace('.', ',') : t))
      }
    })
    return () => { vivo = false }
  }, [pedido.id])

  async function salvar(valor) {
    const v = typeof valor === 'number' ? valor : parseFloat(String(txt).replace(',', '.'))
    if (!Number.isFinite(v) || v < 0) { setErro('Digite um valor válido.'); return }
    setSalvando(true); setErro(null)
    const { error } = await supabase.rpc('entregador_informar_valor', { p_pedido: pedido.id, p_valor: v })
    setSalvando(false)
    if (error) { setErro(error.message || 'Não consegui salvar. Tente de novo.'); return }
    const arred = Math.round(v * 100) / 100
    const igualAoSistema = sugerido != null && Math.abs(arred - sugerido) < 0.005
    onSalvo?.({
      valor_entregador: arred,
      valor_entregador_calculado: sugerido,
      valor_entregador_origem: igualAoSistema ? 'calculado' : 'dono',
    })
    onFechar()
  }

  return (
    <div className="pp-modal-overlay" onClick={onFechar} style={{ zIndex: 140 }}>
      <div className="pp-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(380px, 94vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 4px' }}>Taxa do motoboy · corrida #{pedido.numero_pedido ?? pedido.id.slice(-4).toUpperCase()}</h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          {pedido.cliente_nome || 'Cliente'}{pedido.endereco_bairro ? ` · ${pedido.endereco_bairro}` : ''}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Valor agora</span>
            <strong>{atual != null ? fmt(atual) : '—'}{pedido.valor_entregador_origem === 'motoboy' ? ' (editado pelo motoboy)' : pedido.valor_entregador_origem === 'dono' ? ' (editado pelo dono)' : atual != null ? ' (calculado)' : ''}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>O sistema calcula</span>
            <strong>{carregandoSug ? '...' : sugerido != null ? fmt(sugerido) : 'não deu pra calcular (sem ponto no mapa)'}</strong>
          </div>
        </div>

        <label style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-muted)' }}>Novo valor da corrida (R$)</label>
        <input
          autoFocus
          value={txt}
          onChange={e => { setTxt(e.target.value.replace(/[^0-9,.]/g, '').slice(0, 7)); setErro(null) }}
          onKeyDown={e => { if (e.key === 'Enter') salvar() }}
          inputMode="decimal"
          placeholder="0,00"
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '12px 10px', textAlign: 'center',
            fontSize: 22, fontWeight: 800, borderRadius: 10,
            border: `2px solid ${erro ? '#ef4444' : 'var(--border, #444)'}`, background: 'var(--bg, #0f0f1a)', color: 'var(--text)',
          }}
        />
        {erro && <p style={{ color: '#ef4444', fontSize: 12.5, margin: '8px 0 0' }}>{erro}</p>}

        {sugerido != null && (atual == null || Math.abs(atual - sugerido) > 0.005) && (
          <button type="button" onClick={() => salvar(sugerido)} disabled={salvando}
            style={{ width: '100%', marginTop: 10, padding: '9px 0', borderRadius: 10, cursor: 'pointer', fontWeight: 700, fontSize: 13,
              background: 'transparent', color: '#7c3aed', border: '1.5px dashed #7c3aed' }}>
            Voltar ao valor do sistema ({fmt(sugerido)})
          </button>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button type="button" className="pp-btn pp-btn-recusar" onClick={onFechar} style={{ flex: '0 0 auto' }}>Cancelar</button>
          <button type="button" className="pp-btn pp-btn-avancar" onClick={() => salvar()} disabled={salvando || txt.trim() === ''} style={{ flex: 1 }}>
            {salvando ? 'Salvando...' : 'Salvar taxa'}
          </button>
        </div>
      </div>
    </div>
  )
}
