import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import './NotificationBell.css'

export default function NotificationBell() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // "Pedidos do portal" saiu junto com a tela de Vendas física: o aviso só
  // servia pra abrir aquela tela, e sem ela levaria a lugar nenhum.
  const [alerts, setAlerts] = useState({ estoque: [], fiado: [] })
  const [dropdownStyle, setDropdownStyle] = useState({})
  const ref = useRef(null)
  const btnRef = useRef(null)

  const total = alerts.estoque.length + alerts.fiado.length

  async function load() {
    const [estoqueRes, fiadoRes] = await Promise.all([
      supabase
        .from('estoque_baixo')
        .select('nome, quantidade_atual, estoque_minimo')
        .order('falta', { ascending: false })
        .limit(10),
      supabase
        .from('alertas_fiado')
        .select('cliente_nome, saldo_fiado')
        .limit(10),
    ])
    setAlerts({
      estoque: estoqueRes.data ?? [],
      fiado:   fiadoRes.data ?? [],
    })
  }

  useEffect(() => {
    if (profile?.perfil !== 'admin') return
    load()
    const interval = setInterval(load, 60_000)
    return () => clearInterval(interval)
  }, [profile])

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (profile?.perfil !== 'admin') return null

  function fmt(val) {
    return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  }

  return (
    <div className="notif-wrap" ref={ref}>
      <button
        className={`notif-btn${open ? ' active' : ''}`}
        ref={btnRef}
        onClick={() => {
          if (!open && btnRef.current) {
            const rect = btnRef.current.getBoundingClientRect()
            const dropW = 320
            let left = rect.right - dropW
            if (left < 8) left = rect.left
            if (left + dropW > window.innerWidth - 8) left = window.innerWidth - dropW - 8
            setDropdownStyle({ top: rect.bottom + 8, left })
          }
          setOpen(o => !o)
        }}
        aria-label="Notificações"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {total > 0 && <span className="notif-badge">{total > 99 ? '99+' : total}</span>}
      </button>

      {open && (
        <div className="notif-dropdown" style={dropdownStyle}>
          <div className="notif-header">
            <span>Alertas</span>
            <button className="notif-refresh" onClick={load} title="Atualizar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
            </button>
          </div>

          {total === 0 ? (
            <div className="notif-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
              <p>Tudo em dia!</p>
            </div>
          ) : (
            <div className="notif-list">
              {alerts.estoque.length > 0 && (
                <div className="notif-section">
                  <div className="notif-section-title notif-estoque">
                    Estoque baixo ({alerts.estoque.length})
                  </div>
                  {alerts.estoque.map(p => (
                    <button
                      key={p.nome}
                      className="notif-item"
                      onClick={() => { navigate('/estoque'); setOpen(false) }}
                    >
                      <div className="notif-item-dot notif-dot-estoque" />
                      <div className="notif-item-body">
                        <span className="notif-item-title">{p.nome}</span>
                        <span className="notif-item-sub">
                          {Number(p.quantidade_atual)} un. · mín. {Number(p.estoque_minimo)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {alerts.fiado.length > 0 && (
                <div className="notif-section">
                  <div className="notif-section-title notif-fiado">
                    Fiado em aberto ({alerts.fiado.length})
                  </div>
                  {alerts.fiado.map(f => (
                    <button
                      key={f.cliente_nome}
                      className="notif-item"
                      onClick={() => { navigate('/financeiro'); setOpen(false) }}
                    >
                      <div className="notif-item-dot notif-dot-fiado" />
                      <div className="notif-item-body">
                        <span className="notif-item-title">{f.cliente_nome}</span>
                        <span className="notif-item-sub">{fmt(f.saldo_fiado)} em aberto</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
