import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { moduloVisivel } from '../lib/modulos'
import '../components/Page.css'

// Sub-categorias do módulo presencial. `pronto:false` aparece como "Em breve".
// Estes cards são a porta de entrada de verdade dessas telas: a lateral só
// mostra a Cozinha, porque o resto já está no /painel (aba "Mesas").
// `mod` esconde o card quando a loja não tem a funcionalidade ligada.
const SUBAREAS = [
  { to: '/presencial/salao', icon: '🗺️', nome: 'Salão', desc: 'Abrir mesas, lançar comanda e fechar a conta', pronto: true },
  { to: '/caixa', icon: '💵', nome: 'Caixa', desc: 'Abertura, sangria e fechamento do caixa', pronto: true, mod: 'caixa' },
  { to: '/presencial/cozinha', icon: '👨‍🍳', nome: 'Cozinha (KDS)', desc: 'Painel de preparo dos pedidos, ao vivo', pronto: true },
  { to: '/presencial/reservas', icon: '📅', nome: 'Reservas e fila', desc: 'Agende mesas e gerencie a fila de espera', pronto: true },
  { to: '/presencial/historico', icon: '🧾', nome: 'Vendas salão', desc: 'Contas fechadas e total recebido', pronto: true },
  { to: '/presencial/mesas', icon: '🪑', nome: 'Mesas', desc: 'Cadastre as mesas do salão', pronto: true },
]

export default function ServicoPresencial() {
  const { profile, empresa } = useAuth()
  const empresaId = profile?.empresa_id
  // Card de módulo desligado vira link morto (a rota devolve pra home).
  const areas = SUBAREAS.filter(a => !a.mod || moduloVisivel(empresa, a.mod))

  const [loading, setLoading]   = useState(true)
  const [ativo, setAtivo]       = useState(false)
  // Comanda de balcão (mig 0143): libera o botão "+ Nova comanda" no Salão, pra loja
  // em que o cliente pede em pé no balcão. Convive com as mesas de verdade.
  const [comandaBalcao, setComandaBalcao] = useState(false)
  // Link do cliente (mig 0147): cada cliente cadastrado ganha um link só dele pra
  // fazer pedido — o pedido vira comanda no nome dele e cai direto na cozinha.
  const [linkCliente, setLinkCliente] = useState(false)
  const [taxa, setTaxa]         = useState(10)
  const [salvando, setSalvando] = useState(false)
  const [msg, setMsg]           = useState(null)

  useEffect(() => {
    if (!empresaId) return
    supabase.from('empresas')
      .select('presencial_ativo, taxa_servico_pct, comanda_balcao_ativa, link_cliente_ativo')
      .eq('id', empresaId).single()
      .then(({ data }) => {
        if (data) {
          setAtivo(data.presencial_ativo ?? false)
          setTaxa(data.taxa_servico_pct ?? 10)
          setComandaBalcao(data.comanda_balcao_ativa ?? false)
          setLinkCliente(data.link_cliente_ativo ?? false)
        }
        setLoading(false)
      })
  }, [empresaId])

  async function salvar() {
    if (!empresaId) return
    setSalvando(true); setMsg(null)
    const { error } = await supabase.from('empresas')
      .update({ presencial_ativo: ativo, taxa_servico_pct: Number(taxa) || 0, comanda_balcao_ativa: comandaBalcao, link_cliente_ativo: linkCliente })
      .eq('id', empresaId)
    setSalvando(false)
    setMsg(error ? { tipo: 'erro', texto: error.message } : { tipo: 'ok', texto: 'Configurações salvas.' })
    if (!error) setTimeout(() => setMsg(null), 2500)
  }

  if (loading) return <div className="page"><p>Carregando...</p></div>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Serviço Presencial</h1>
          <p className="page-subtitle">Atendimento no local: mesas, comandas e cozinha.</p>
        </div>
      </div>

      {/* Configuração */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Ativar serviço presencial</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
              Libera o módulo de mesas e comandas para esta loja.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAtivo(v => !v)}
            aria-label="Ativar serviço presencial"
            style={{
              width: 52, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer',
              position: 'relative', flexShrink: 0,
              background: ativo ? 'var(--primary)' : 'var(--border)', transition: 'background 150ms',
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: ativo ? 25 : 3, width: 24, height: 24,
              borderRadius: '50%', background: '#fff', transition: 'left 150ms',
            }} />
          </button>
        </div>

        {/* Comanda de balcão: pro cliente que pede em pé e leva um número (01, 02...). */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ maxWidth: 520 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Comandas de balcão</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
              Põe o botão <b>“+ Nova comanda”</b> no Salão. A comanda não é de mesa nenhuma:
              nasce com número automático (01, 02, 03...) que <b>zera todo dia</b> e leva o nome
              do cliente. Serve pra quem pede em pé no balcão. As mesas continuam funcionando igual.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setComandaBalcao(v => !v)}
            aria-label="Ativar comandas de balcão"
            style={{
              width: 52, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer',
              position: 'relative', flexShrink: 0,
              background: comandaBalcao ? 'var(--primary)' : 'var(--border)', transition: 'background 150ms',
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: comandaBalcao ? 25 : 3, width: 24, height: 24,
              borderRadius: '50%', background: '#fff', transition: 'left 150ms',
            }} />
          </button>
        </div>

        {/* Link do cliente: ele mesmo faz o pedido, do celular dele. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <div style={{ maxWidth: 520 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Link de pedido do cliente</div>
            <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
              Cada cliente cadastrado ganha um <b>link só dele</b> (o botão 🔗 aparece na tela de Clientes).
              Por esse link ele monta o pedido — que <b>cai direto na cozinha</b> como comanda no nome dele —,
              acompanha quando fica pronto e vê <b>quanto está devendo</b> de fiado e o que já pagou.
              Fora do horário da loja ele não consegue enviar.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLinkCliente(v => !v)}
            aria-label="Ativar link de pedido do cliente"
            style={{
              width: 52, height: 30, borderRadius: 999, border: 'none', cursor: 'pointer',
              position: 'relative', flexShrink: 0,
              background: linkCliente ? 'var(--primary)' : 'var(--border)', transition: 'background 150ms',
            }}
          >
            <span style={{
              position: 'absolute', top: 3, left: linkCliente ? 25 : 3, width: 24, height: 24,
              borderRadius: '50%', background: '#fff', transition: 'left 150ms',
            }} />
          </button>
        </div>

        <div className="form-field" style={{ marginTop: 16, maxWidth: 220 }}>
          <label>Taxa de serviço (%)</label>
          <input type="number" min="0" max="100" step="0.5" value={taxa}
            onChange={e => setTaxa(e.target.value)} />
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Sugestão de gorjeta aplicada no fechamento da conta (opcional).
          </span>
        </div>

        {msg && (
          <div style={{ marginTop: 12, fontSize: 13, color: msg.tipo === 'ok' ? 'var(--success)' : 'var(--danger)' }}>
            {msg.texto}
          </div>
        )}

        <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={salvar} disabled={salvando}>
          {salvando ? 'Salvando...' : 'Salvar configurações'}
        </button>
      </div>

      {/* Sub-áreas */}
      <h2 style={{ fontSize: 15, margin: '0 0 12px' }}>Áreas do presencial</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
        {areas.map(area => {
          const conteudo = (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 26 }}>{area.icon}</span>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{area.nome}</span>
                {!area.pronto && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>
                    Em breve
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>{area.desc}</div>
            </>
          )
          const baseStyle = {
            display: 'block', padding: 16, borderRadius: 12,
            border: '1px solid var(--border)', background: 'var(--card-bg, var(--bg))',
            textDecoration: 'none', color: 'var(--text)',
          }
          return area.pronto
            ? <Link key={area.to} to={area.to} style={baseStyle}>{conteudo}</Link>
            : <div key={area.to} style={{ ...baseStyle, opacity: 0.6, cursor: 'default' }}>{conteudo}</div>
        })}
      </div>
    </div>
  )
}
