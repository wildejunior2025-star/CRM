import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { dataBr } from '../../lib/academiaPagamento'

// "Minha ficha" do aluno: as medidas da última avaliação e, do lado, o quanto
// mudou desde a anterior. É o que o cartão de papel nunca mostrou pra ele —
// e é o que faz a pessoa continuar treinando.
//
// Aqui ele só OLHA. Medir é trabalho do professor (a ficha fica no sistema da
// academia); aluno mexendo nos próprios números estragaria o histórico.

const MEDIDAS = [
  { id: 'peso', nome: 'Peso', unidade: 'kg' },
  { id: 'cintura', nome: 'Cintura', unidade: 'cm' },
  { id: 'peitoral', nome: 'Peitoral', unidade: 'cm' },
  { id: 'ombro', nome: 'Ombro', unidade: 'cm' },
  { id: 'quadril', nome: 'Quadril', unidade: 'cm' },
  { id: 'braco_dir', nome: 'Braço direito', unidade: 'cm' },
  { id: 'braco_esq', nome: 'Braço esquerdo', unidade: 'cm' },
  { id: 'antebraco_dir', nome: 'Antebraço direito', unidade: 'cm' },
  { id: 'antebraco_esq', nome: 'Antebraço esquerdo', unidade: 'cm' },
  { id: 'coxa_dir', nome: 'Coxa direita', unidade: 'cm' },
  { id: 'coxa_esq', nome: 'Coxa esquerda', unidade: 'cm' },
  { id: 'panturrilha_dir', nome: 'Panturrilha direita', unidade: 'cm' },
  { id: 'panturrilha_esq', nome: 'Panturrilha esquerda', unidade: 'cm' },
  { id: 'estatura', nome: 'Altura', unidade: 'cm' },
]

const mostra = v => (v === null || v === undefined ? '—' : String(Number(v)).replace('.', ','))

// Gráfico simples da evolução de uma medida. Desenhado à mão em SVG: é uma
// linha com pontos, não precisa de biblioteca nenhuma.
function Linha({ titulo, unidade, pontos, cor }) {
  if (pontos.length < 2) return null
  const largura = 300
  const altura = 90
  const valores = pontos.map(p => p.valor)
  const min = Math.min(...valores)
  const max = Math.max(...valores)
  const vao = max - min || 1
  const x = i => (i / (pontos.length - 1)) * (largura - 24) + 12
  const y = v => altura - 16 - ((v - min) / vao) * (altura - 36)
  const caminho = pontos.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.valor).toFixed(1)}`).join(' ')
  const primeiro = pontos[0].valor
  const ultimo = pontos[pontos.length - 1].valor
  const dif = Number((ultimo - primeiro).toFixed(1))

  return (
    <div className="al-grafico">
      <div className="al-grafico-topo">
        <span>{titulo}</span>
        <strong className={dif > 0 ? 'subiu' : dif < 0 ? 'desceu' : ''}>
          {dif > 0 ? '+' : ''}{String(dif).replace('.', ',')} {unidade}
        </strong>
      </div>
      <svg viewBox={`0 0 ${largura} ${altura}`} width="100%" height={altura} role="img"
        aria-label={`${titulo}: de ${primeiro} a ${ultimo} ${unidade}`}>
        <path d={caminho} fill="none" stroke={cor} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        {pontos.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.valor)} r="4" fill={cor} />
        ))}
        <text x="12" y={altura - 2} fontSize="11" fill="#6b6880">{pontos[0].quando}</text>
        <text x={largura - 12} y={altura - 2} fontSize="11" fill="#6b6880" textAnchor="end">
          {pontos[pontos.length - 1].quando}
        </text>
      </svg>
    </div>
  )
}

export default function AlunoFicha({ aluno }) {
  const [avaliacoes, setAvaliacoes] = useState(null)

  useEffect(() => {
    supabase
      .from('academia_avaliacoes')
      .select('*')
      .eq('aluno_id', aluno.id)
      .order('data', { ascending: false })
      .then(({ data }) => setAvaliacoes(data || []))
  }, [aluno.id])

  if (avaliacoes === null) return <p className="al-vazio">Carregando...</p>

  if (avaliacoes.length === 0) {
    return (
      <section className="al-bloco">
        <p className="al-texto">Sua primeira avaliação ainda não foi feita. Fale com o professor.</p>
      </section>
    )
  }

  const ultima = avaliacoes[0]
  const anterior = avaliacoes[1]
  const linhas = MEDIDAS.filter(m => ultima[m.id] != null)

  return (
    <>
      <section className="al-medida-topo">
        <span>Medido em <b>{dataBr(ultima.data)}</b></span>
        {anterior && <span>comparando com {dataBr(anterior.data)}</span>}
      </section>

      <section className="al-bloco">
        <ul className="al-medidas">
          {linhas.map(m => {
            const agora = Number(ultima[m.id])
            const antes = anterior?.[m.id] != null ? Number(anterior[m.id]) : null
            const dif = antes === null ? null : Number((agora - antes).toFixed(1))
            return (
              <li key={m.id}>
                <span className="al-medida-nome">{m.nome}</span>
                <span className="al-medida-valor">
                  <strong>{mostra(agora)}</strong> {m.unidade}
                </span>
                <span className={`al-medida-dif${dif > 0 ? ' subiu' : dif < 0 ? ' desceu' : ''}`}>
                  {dif === null || dif === 0 ? '—' : `${dif > 0 ? '↑ +' : '↓ '}${String(dif).replace('.', ',').replace('-', '')}`}
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      {avaliacoes.length > 1 && (
        <section className="al-bloco">
          <h2>Sua evolução</h2>
          {[
            { id: 'peso', titulo: 'Peso', unidade: 'kg', cor: '#7c3aed' },
            { id: 'cintura', titulo: 'Cintura', unidade: 'cm', cor: '#15803d' },
            { id: 'braco_dir', titulo: 'Braço', unidade: 'cm', cor: '#b45309' },
          ].map(m => (
            <Linha
              key={m.id}
              titulo={m.titulo}
              unidade={m.unidade}
              cor={m.cor}
              pontos={[...avaliacoes].reverse()
                .filter(a => a[m.id] != null)
                .map(a => ({ valor: Number(a[m.id]), quando: dataBr(a.data).slice(0, 5) }))}
            />
          ))}
        </section>
      )}

      {avaliacoes.length > 1 && (
        <section className="al-bloco">
          <h2>Avaliações anteriores</h2>
          <ul className="al-entradas">
            {avaliacoes.slice(1).map(av => (
              <li key={av.id}>
                <span>{dataBr(av.data)}</span>
                <strong>
                  {av.peso != null ? `${mostra(av.peso)} kg` : ''}
                  {av.peso != null && av.cintura != null ? ' · ' : ''}
                  {av.cintura != null ? `cintura ${mostra(av.cintura)}` : ''}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
