import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { recadoDeErro } from '../lib/erroRede'
import '../components/Page.css'

// O QUE FOI DESFEITO — item tirado da comanda e mesa cancelada (mig 0320).
//
// Nasceu como uma seção no fim do histórico e ficou escondida: o garçom tinha
// que rolar a tela inteira pra chegar nela. Virou tela própria, logo abaixo de
// "Minhas mesas" no menu dele.
//
// A RLS decide o que cada um lê: garçom só o dele, dono a loja inteira. Esta
// tela não filtra nada por conta própria — se filtrasse, seria a segunda regra
// sobre o mesmo assunto, e uma hora as duas discordariam.
const fmt = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
const quando = (iso) => new Date(iso).toLocaleString('pt-BR', {
  timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
})

export default function PresencialDesfeitos() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id
  const ehAdmin = profile?.perfil === 'admin' || profile?.perfil === 'super_admin'

  const [eventos, setEventos] = useState([])
  const [nomes, setNomes] = useState({})
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  // Comanda aberta no popup, SÓ PRA CONFERIR. Nada aqui muda nada: a comanda
  // já foi cancelada ou o item já saiu — é consulta, não edição.
  const [vendo, setVendo] = useState(null)
  const [itens, setItens] = useState(null)

  const carregar = useCallback(async () => {
    if (!empresaId) return
    setLoading(true); setErro(null)
    try {
      const [ev, us] = await Promise.all([
        supabase.from('comanda_eventos')
          .select('id, tipo, rotulo, quem, quando, descricao, quantidade, valor, comanda_id')
          .eq('empresa_id', empresaId).order('quando', { ascending: false }).limit(200),
        supabase.from('profiles').select('id, nome').eq('empresa_id', empresaId),
      ])
      if (ev.error) throw ev.error
      setEventos(ev.data ?? [])
      setNomes(Object.fromEntries((us.data ?? []).map(p => [p.id, p.nome])))
    } catch (e) {
      setErro(recadoDeErro(e, 'carregar os registros'))
    } finally {
      setLoading(false)
    }
  }, [empresaId])

  useEffect(() => { carregar() }, [carregar])

  async function abrirComanda(ev) {
    if (!ev.comanda_id) return
    setVendo(ev); setItens(null)
    const { data } = await supabase.from('comandas')
      .select('numero_mesa, nome_cliente, status, total, subtotal, taxa_servico, created_at, fechada_at, comanda_itens(nome, quantidade, preco_unitario, observacao)')
      .eq('id', ev.comanda_id).maybeSingle()
    // Comanda apagada depois: o registro continua valendo, só não tem o que abrir.
    setItens(data ?? { sumiu: true })
  }

  const totalValor = eventos.reduce((s, e) => s + Number(e.valor || 0), 0)

  if (!empresaId) return <div className="card">Selecione uma loja.</div>

  return (
    <div>
      <div className="page-header">
        <div>
          <Link to={ehAdmin ? '/presencial' : '/presencial/salao'} style={{ color: 'var(--primary)', fontSize: 13 }}>
            {ehAdmin ? '← Serviço Presencial' : '← Salão'}
          </Link>
          <h1>{ehAdmin ? 'Cancelamentos e itens removidos' : 'O que você desfez'}</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '2px 0 0' }}>
            {ehAdmin
              ? 'Mesa cancelada e item tirado da comanda, com quem fez e quando.'
              : 'Mesa que você cancelou ou item que você tirou da comanda. Toque pra conferir.'}
          </p>
        </div>
      </div>

      {erro && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{erro}</div>}

      {!loading && eventos.length > 0 && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 13.5 }}>{eventos.length} {eventos.length === 1 ? 'registro' : 'registros'}</span>
          <strong style={{ fontSize: 15 }}>{fmt(totalValor)}</strong>
        </div>
      )}

      <div className="card">
        {loading ? (
          <div style={{ fontSize: 13, opacity: .7 }}>Carregando…</div>
        ) : eventos.length === 0 ? (
          <div style={{ fontSize: 13.5, color: 'var(--text-muted)' }}>
            Nada desfeito por aqui. Quando alguém tirar um item da comanda ou cancelar uma mesa, aparece nesta lista.
          </div>
        ) : eventos.map(ev => (
          <button key={ev.id} type="button" onClick={() => abrirComanda(ev)}
            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '11px 0',
              borderBottom: '1px solid var(--border)', border: 'none', borderRadius: 0,
              background: 'transparent', color: 'var(--text)', textAlign: 'left',
              cursor: ev.comanda_id ? 'pointer' : 'default' }}>
            <span style={{ fontSize: 17 }}>{ev.tipo === 'comanda_cancelada' ? '🚫' : '➖'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>
                {ev.tipo === 'comanda_cancelada'
                  ? `Cancelou ${ev.rotulo || 'a comanda'}`
                  : `Tirou ${Number(ev.quantidade || 1)}x ${ev.descricao || 'item'}`}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {ehAdmin && <>{nomes[ev.quem] || 'alguém'} · </>}
                {quando(ev.quando)}
                {ev.tipo === 'item_removido' && ev.rotulo ? ` · ${ev.rotulo}` : ''}
                {ev.tipo === 'comanda_cancelada' ? ` · ${ev.descricao}` : ''}
              </div>
            </div>
            {Number(ev.valor) > 0 && (
              <strong style={{ fontSize: 14, color: 'var(--danger)', whiteSpace: 'nowrap' }}>{fmt(ev.valor)}</strong>
            )}
          </button>
        ))}
      </div>

      {/* Popup de CONFERÊNCIA. Só mostra — não tem botão que mexa em nada. */}
      {vendo && (
        <div onClick={() => { setVendo(null); setItens(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 60,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: '100%', maxWidth: 420, maxHeight: '85dvh', overflowY: 'auto',
              background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 16, padding: 18 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{vendo.rotulo || 'Comanda'}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 2 }}>
              {vendo.tipo === 'comanda_cancelada' ? 'Comanda cancelada' : `Item removido: ${vendo.descricao}`}
              {' · '}{quando(vendo.quando)}
              {ehAdmin && <> · {nomes[vendo.quem] || 'alguém'}</>}
            </div>

            {itens === null ? (
              <div style={{ fontSize: 13, opacity: .7, marginTop: 14 }}>Carregando a comanda…</div>
            ) : itens.sumiu ? (
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 14 }}>
                Esta comanda não existe mais no sistema. O registro acima continua valendo.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 12 }}>
                  Aberta em {quando(itens.created_at)}
                  {itens.fechada_at && <> · fechada em {quando(itens.fechada_at)}</>}
                  {' · '}<strong>{itens.status}</strong>
                </div>

                <div style={{ fontWeight: 800, fontSize: 13.5, margin: '14px 0 4px' }}>
                  O que ficou na comanda
                </div>
                {(itens.comanda_itens ?? []).length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nenhum item.</div>
                ) : (itens.comanda_itens ?? []).map((it, k) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                    padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
                    <span style={{ minWidth: 0 }}>
                      {it.quantidade}x {it.nome}
                      {it.observacao && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>▸ {it.observacao}</div>}
                    </span>
                    <strong style={{ whiteSpace: 'nowrap' }}>{fmt(it.preco_unitario * it.quantidade)}</strong>
                  </div>
                ))}

                {Number(itens.total) > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 15, fontWeight: 800 }}>
                    <span>Total da conta</span><span>{fmt(itens.total)}</span>
                  </div>
                )}
                {/* O item desfeito NÃO está mais na lista acima — por isso o
                    lembrete: senão o garçom procura e não acha. */}
                {vendo.tipo === 'item_removido' && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.35 }}>
                    O {vendo.descricao} não aparece na lista porque foi justamente ele que saiu.
                  </div>
                )}
              </>
            )}

            <button type="button" onClick={() => { setVendo(null); setItens(null) }}
              className="btn btn-secondary" style={{ width: '100%', marginTop: 16 }}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
