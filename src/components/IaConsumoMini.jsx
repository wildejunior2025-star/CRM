// Barrinha de consumo da IA no pé do menu — igual à do Claude.
//
// Fica sempre à vista, e não escondida dentro da caixa do robô: quem só abre o
// robô descobre o limite quando ele para, e aí a sensação é de sistema quebrado,
// não de franquia acabada.
//
// Clicar abre a tela com o extrato e o saldo.

import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useIaConsumo } from '../hooks/useIaConsumo'

export default function IaConsumoMini() {
  const { profile } = useAuth()
  const c = useIaConsumo()

  // Mesma regra do botão do assistente: número de consumo é assunto de dono.
  if (profile?.perfil !== 'admin' && profile?.perfil !== 'super_admin') return null
  if (c.carregando) return null

  const acabou = c.disponivel <= 0
  const cor = acabou ? 'var(--danger)' : c.pct >= 80 ? 'var(--warning)' : 'var(--primary)'

  return (
    <NavLink to="/assistente-ia" style={S.link}
      title={`R$ ${c.usado.toFixed(2)} de R$ ${c.franquia.toFixed(2)} usados este mês`}>
      <div style={S.linha}>
        <span>Assistente IA</span>
        {/* Só a porcentagem — a estimativa de perguntas poluía o canto. Quando
            acaba, "Acabou" no lugar do número: 100% sozinho não diz o que fazer. */}
        <strong style={{ color: cor }}>{acabou ? 'Acabou' : `${c.pct}%`}</strong>
      </div>
      <div style={S.trilho}>
        <div style={{ ...S.barra, width: `${c.pct}%`, background: cor }} />
      </div>
    </NavLink>
  )
}

const S = {
  link: {
    display: 'block', padding: '8px', borderRadius: 9,
    textDecoration: 'none', color: 'inherit',
    border: '1px solid var(--border)', background: 'var(--bg)',
  },
  linha: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 5, fontWeight: 600,
  },
  trilho: { height: 5, borderRadius: 999, background: 'var(--border)', overflow: 'hidden' },
  barra: { height: '100%', borderRadius: 999, transition: 'width 400ms' },
}
