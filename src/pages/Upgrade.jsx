// Tela que aparece quando a loja clica num módulo BLOQUEADO pelo plano.
//
// Regra de ouro: nunca parecer defeito. Bloqueado tem que parecer bloqueado —
// com explicação do que a loja ganha e um caminho claro pra liberar. Tela
// branca ou erro aqui vira reclamação em vez de venda.

import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { pitchUpgrade, labelModulo } from '../lib/modulos'
import '../components/Page.css'

export default function Upgrade() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { empresa } = useAuth()
  const mod = params.get('mod') || ''
  const pitch = pitchUpgrade(mod)

  // Número de quem vende (você). Cadastre em configuracoes_plataforma na chave
  // 'whatsapp_suporte'. Sem ele, o botão cai num e-mail — nunca fica sem ação.
  const [zapSuporte, setZapSuporte] = useState('')
  useEffect(() => {
    supabase.from('configuracoes_plataforma').select('valor').eq('chave', 'whatsapp_suporte').maybeSingle()
      .then(({ data }) => setZapSuporte((data?.valor || '').replace(/\D/g, '')))
  }, [])

  const msg = encodeURIComponent(
    `Olá! Sou da loja ${empresa?.nome ?? ''} e quero liberar ${labelModulo(mod)} no meu plano.`
  )
  const zap = zapSuporte

  return (
    <div>
      <div className="page-header">
        <h1>{labelModulo(mod)}</h1>
      </div>

      <div style={{
        maxWidth: 620, background: 'var(--card-bg, var(--bg))',
        border: '1px solid var(--border)', borderRadius: 16, padding: 28,
      }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, marginBottom: 16,
          background: 'rgba(124,58,237,.12)', border: '1px solid rgba(124,58,237,.35)',
          borderRadius: 999, padding: '5px 12px', fontSize: 12, fontWeight: 700,
          color: 'var(--primary)',
        }}>
          🔒 Não incluído no seu plano
        </div>

        <h2 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>
          {pitch.titulo}
        </h2>
        <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 15, lineHeight: 1.6 }}>
          {pitch.resumo}
        </p>

        {pitch.itens.length > 0 && (
          <ul style={{ margin: '0 0 24px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {pitch.itens.map((it, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 14.5, lineHeight: 1.5 }}>
                <span aria-hidden style={{ color: 'var(--success, #16a34a)', fontWeight: 800, flexShrink: 0 }}>✓</span>
                <span>{it}</span>
              </li>
            ))}
          </ul>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a
            className="btn btn-primary"
            href={zap ? `https://wa.me/${zap}?text=${msg}` : `mailto:contato@fwcinter.com?subject=Upgrade&body=${msg}`}
            target="_blank" rel="noreferrer"
            style={{ textDecoration: 'none' }}
          >
            Liberar agora
          </a>
          <button className="btn btn-secondary" type="button" onClick={() => navigate(-1)}>
            Voltar
          </button>
        </div>
      </div>
    </div>
  )
}
