import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { CHECKLIST_INSTALACAO, TOTAL_ITENS_CHECKLIST } from '../lib/checklistInstalacao'

// Pop-up do checklist de instalação de UMA loja (Super Admin → card da loja).
// Cada toque grava na hora: pode fechar e voltar depois, e quem mais abrir a
// loja vê o que já foi feito, por quem e quando. A lista de itens está em
// src/lib/checklistInstalacao.js; aqui só mora a tela.
export default function ChecklistInstalacao({ empresa, onFechar, onMudou }) {
  const { profile, user } = useAuth()
  const [feitos, setFeitos] = useState({}) // { [key]: { feito_em, feito_por_nome } }
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState(null)
  const [salvando, setSalvando] = useState(null) // key em gravação
  const [fechados, setFechados] = useState({})   // grupos recolhidos

  useEffect(() => {
    let vivo = true
    ;(async () => {
      const { data, error } = await supabase
        .from('empresa_checklist')
        .select('item, feito_em, feito_por_nome')
        .eq('empresa_id', empresa.id)
      if (!vivo) return
      if (error) setErro('Não consegui carregar o checklist: ' + error.message)
      else setFeitos(Object.fromEntries((data ?? []).map(r => [r.item, r])))
      setCarregando(false)
    })()
    return () => { vivo = false }
  }, [empresa.id])

  // Só conta o que ainda existe na lista (item removido do código não pesa).
  const chavesValidas = new Set(CHECKLIST_INSTALACAO.flatMap(g => g.itens.map(i => i.key)))
  const total = TOTAL_ITENS_CHECKLIST
  const feitosN = Object.keys(feitos).filter(k => chavesValidas.has(k)).length
  const pct = total ? Math.round((feitosN / total) * 100) : 0
  const completo = feitosN >= total

  async function alternar(key) {
    if (salvando) return
    setErro(null)
    setSalvando(key)
    const jaFeito = !!feitos[key]
    const antes = feitos
    let proximo
    if (jaFeito) {
      proximo = { ...feitos }
      delete proximo[key]
      setFeitos(proximo)
      const { error } = await supabase.from('empresa_checklist').delete().eq('empresa_id', empresa.id).eq('item', key)
      if (error) { setFeitos(antes); setErro('Não consegui desmarcar: ' + error.message); setSalvando(null); return }
    } else {
      const quem = profile?.nome || user?.email || 'Super Admin'
      const agora = new Date().toISOString()
      proximo = { ...feitos, [key]: { item: key, feito_em: agora, feito_por_nome: quem } }
      setFeitos(proximo)
      const { error } = await supabase.from('empresa_checklist').upsert({
        empresa_id: empresa.id, item: key, feito_em: agora, feito_por: user?.id ?? null, feito_por_nome: quem,
      }, { onConflict: 'empresa_id,item' })
      if (error) { setFeitos(antes); setErro('Não consegui marcar: ' + error.message); setSalvando(null); return }
    }
    setSalvando(null)
    onMudou?.(empresa.id, Object.keys(proximo).filter(k => chavesValidas.has(k)).length)
  }

  const quando = (iso) => {
    try {
      return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' })
    } catch { return '' }
  }

  return (
    <div className="modal-overlay" onClick={onFechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 600, maxHeight: '90vh', overflowY: 'auto' }}>
        <h2 style={{ marginBottom: 2 }}>Checklist de instalação</h2>
        <p style={{ margin: '0 0 10px', color: 'var(--text-muted)', fontSize: 14 }}>
          Loja: <strong style={{ color: 'var(--text)' }}>{empresa.nome}</strong>
        </p>

        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 700, marginBottom: 4 }}>
            <span>{completo ? '✅ Tudo feito — nada esquecido' : `${feitosN} de ${total} feitos`}</span>
            <span>{pct}%</span>
          </div>
          <div style={{ height: 8, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: completo ? 'var(--success)' : 'var(--primary)', transition: 'width 200ms' }} />
          </div>
        </div>

        {erro && (
          <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 8, padding: '8px 12px', marginBottom: 12, fontSize: 13 }}>
            {erro}
          </div>
        )}

        {carregando ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Carregando…</p>
        ) : (
          CHECKLIST_INSTALACAO.map(g => {
            const n = g.itens.filter(i => feitos[i.key]).length
            const fechado = !!fechados[g.id]
            return (
              <div key={g.id} style={{ marginBottom: 10, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <button
                  type="button"
                  onClick={() => setFechados(p => ({ ...p, [g.id]: !p[g.id] }))}
                  aria-expanded={!fechado}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                    padding: '10px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
                    background: 'var(--surface-2, transparent)', color: 'var(--text)', fontSize: 14, fontWeight: 800,
                  }}
                >
                  <span>{fechado ? '▸' : '▾'} {g.titulo}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: n === g.itens.length ? 'var(--success)' : 'var(--text-muted)' }}>
                    {n === g.itens.length ? '✓ ' : ''}{n}/{g.itens.length}
                  </span>
                </button>

                {!fechado && (
                  <div>
                    {g.aviso && (
                      <div style={{ padding: '6px 12px', fontSize: 12, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>{g.aviso}</div>
                    )}
                    {g.itens.map(i => {
                      const f = feitos[i.key]
                      return (
                        <label
                          key={i.key}
                          style={{
                            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
                            borderTop: '1px solid var(--border)', cursor: salvando ? 'wait' : 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!f}
                            disabled={!!salvando}
                            onChange={() => alternar(i.key)}
                            style={{ width: 20, height: 20, flexShrink: 0, marginTop: 1 }}
                          />
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ display: 'block', fontSize: 14, color: f ? 'var(--text-muted)' : 'var(--text)', textDecoration: f ? 'line-through' : 'none' }}>
                              {i.texto}
                            </span>
                            {i.dica && !f && (
                              <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{i.dica}</span>
                            )}
                            {f && (
                              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                                ✓ {f.feito_por_nome ? `${f.feito_por_nome} · ` : ''}{quando(f.feito_em)}
                              </span>
                            )}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn btn-primary" onClick={onFechar}>Fechar</button>
        </div>
      </div>
    </div>
  )
}
