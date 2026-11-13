// Calendário mensal da encomenda (mig 0452).
//
// Serve aos dois lados: o cliente escolhe o dia da encomenda no checkout, e a
// dona libera/bloqueia os dias no gestor. O componente só desenha e avisa qual
// dia foi tocado; quem decide o que cada dia significa é quem usa, via `info`.
//
//   info(ymd)         → { estado: 'livre' | 'lotado' | 'fechado' | 'passado', sub?: string }
//   clicavel(ymd)     → pode tocar nesse dia?
//   selecionado       → 'YYYY-MM-DD' marcado
//   onEscolher(ymd)   → toque num dia clicável
//
// Datas são sempre texto 'YYYY-MM-DD' (sem fuso): `new Date('2026-11-20')`
// viraria o dia 19 num celular em outro fuso.
import { useState } from 'react'
import './CalendarioEncomenda.css'

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const SEMANA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']
const p2 = (n) => String(n).padStart(2, '0')
const ymdDe = (a, m, d) => `${a}-${p2(m + 1)}-${p2(d)}`

export default function CalendarioEncomenda({
  info, clicavel, selecionado, onEscolher, inicio, ultimoMes,
}) {
  // inicio: 'YYYY-MM-DD' do primeiro mês a mostrar (hoje, normalmente).
  const [ano0, mes0] = String(inicio).split('-').map(Number)
  const [pos, setPos] = useState(0)   // quantos meses depois do inicial
  const total = ano0 * 12 + (mes0 - 1) + pos
  const ano = Math.floor(total / 12)
  const mes = total % 12

  const diasNoMes = new Date(ano, mes + 1, 0).getDate()
  const vazios = new Date(ano, mes, 1).getDay()
  const celulas = []
  for (let i = 0; i < vazios; i++) celulas.push(null)
  for (let d = 1; d <= diasNoMes; d++) celulas.push(ymdDe(ano, mes, d))

  const maxPos = Math.max(0, Number(ultimoMes ?? 6))

  return (
    <div className="cal-enc">
      <div className="cal-enc-topo">
        <button type="button" className="cal-enc-seta" onClick={() => setPos(p => Math.max(0, p - 1))}
          disabled={pos === 0} aria-label="Mês anterior">‹</button>
        <strong>{MESES[mes]} {ano}</strong>
        <button type="button" className="cal-enc-seta" onClick={() => setPos(p => Math.min(maxPos, p + 1))}
          disabled={pos >= maxPos} aria-label="Próximo mês">›</button>
      </div>
      <div className="cal-enc-grade cal-enc-semana">
        {SEMANA.map((s, i) => <span key={i}>{s}</span>)}
      </div>
      <div className="cal-enc-grade">
        {celulas.map((ymd, i) => {
          if (!ymd) return <span key={`v${i}`} />
          const inf = info(ymd) || { estado: 'fechado' }
          const pode = !!clicavel?.(ymd)
          const cls = `cal-enc-dia cal-enc-dia--${inf.estado}${selecionado === ymd ? ' cal-enc-dia--sel' : ''}`
          return (
            <button key={ymd} type="button" className={cls} disabled={!pode}
              onClick={() => onEscolher?.(ymd)}
              title={inf.estado === 'lotado' ? 'Lotado' : inf.estado === 'fechado' ? 'Sem encomenda nesse dia' : undefined}>
              <span className="cal-enc-num">{Number(ymd.slice(8))}</span>
              {inf.sub ? <span className="cal-enc-sub">{inf.sub}</span> : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
