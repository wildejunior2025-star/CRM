import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import Estoque from './Estoque'
import FichaTecnica from './FichaTecnica'
import LancarCompra from './LancarCompra'
import HistoricoEstoque from './HistoricoEstoque'
import ContagemEstoque from './ContagemEstoque'
import CozinhaRequisicao from './CozinhaRequisicao'
import ConferenciaMes from './ConferenciaMes'
import '../components/Page.css'

// ESTOQUE — tudo de mercadoria num lugar só.
//
// 27/10/2026: o estoque estava espalhado em 9 lugares (Financeiro, Ficha Técnica, Catálogo), com três telas
// pra ver o que entrou e quatro portas pra dar entrada. O Wilde pediu: "quanto menos a gente passear pelas
// telas, melhor". Aqui ficam as abas, e cada uma é a tela que já existia:
//   Tem agora (produto do catálogo OU matéria-prima, numa chave) · Lançar compra · Entrou e saiu ·
//   Contar · Cozinha · Conferência do mês.
// Financeiro ficou só com dinheiro; Ficha Técnica, só com as receitas.
// O vendedor vê só "Tem agora" — valores, compras e conferência são do dono.

const ABAS = [
  ['agora', '📦 Tem agora', false],
  ['compra', '🛒 Lançar compra', true],
  ['movimentos', '📜 Entrou e saiu', true],
  ['contar', '📋 Contar', true],
  ['cozinha', '🍳 Cozinha', true],
  ['conferencia', '🧮 Conferência do mês', true],
]

const pilula = (on) => ({ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700,
  background: on ? 'var(--primary)' : 'transparent', color: on ? '#fff' : 'var(--text-muted)', whiteSpace: 'nowrap' })

export default function EstoqueHub() {
  const { profile } = useAuth()
  const empresaId = profile?.empresa_id ?? null
  const dono = profile?.perfil === 'admin'
  const [params, setParams] = useSearchParams()

  const abas = ABAS.filter(([, , soDono]) => dono || !soDono)
  const aba = abas.some(([id]) => id === params.get('aba')) ? params.get('aba') : 'agora'
  const qual = params.get('item') === 'mp' ? 'mp' : 'prod'
  const muda = (chave, valor) => setParams((p) => { const n = new URLSearchParams(p); n.set(chave, valor); return n }, { replace: true })

  return (
    <div>
      <div className="page-header" style={{ marginBottom: 10 }}>
        <h1>📦 Estoque</h1>
      </div>

      {abas.length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {abas.map(([id, lb]) => (
            <button key={id} type="button" style={pilula(aba === id)} onClick={() => muda('aba', id)}>{lb}</button>
          ))}
        </div>
      )}

      {aba === 'agora' && (
        <>
          <div style={{ display: 'inline-flex', padding: 4, gap: 4, borderRadius: 999, border: '1px solid var(--border)', background: 'var(--bg-card, #fff)', marginBottom: 14 }}>
            {[['prod', '📦 Produtos'], ['mp', '🥩 Matérias-primas']].map(([id, lb]) => (
              <button key={id} type="button" onClick={() => muda('item', id)} aria-pressed={qual === id}
                style={{ padding: '8px 16px', borderRadius: 999, border: 0, cursor: 'pointer', fontSize: 14, fontWeight: 700,
                  background: qual === id ? 'var(--primary)' : 'transparent', color: qual === id ? '#fff' : 'var(--text-muted)' }}>
                {lb}
              </button>
            ))}
          </div>
          {qual === 'prod' ? <Estoque embutido /> : <FichaTecnica modo="insumos" />}
        </>
      )}
      {aba === 'compra' && <LancarCompra empresaId={empresaId} />}
      {aba === 'movimentos' && <HistoricoEstoque empresaId={empresaId} />}
      {aba === 'contar' && <ContagemEstoque empresaId={empresaId} />}
      {aba === 'cozinha' && <CozinhaRequisicao empresaId={empresaId} />}
      {aba === 'conferencia' && <ConferenciaMes onContar={() => muda('aba', 'contar')} />}
    </div>
  )
}
