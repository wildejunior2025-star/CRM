import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'

// "Meus treinos" do aluno: o treino do dia primeiro, com o número da máquina
// de cada exercício — é por ele que o aluno acha o aparelho na academia.
//
// Série e repetição vêm do microciclo (a tabela de semanas do cartão): se o
// professor tiver montado, cada exercício mostra "3 séries de 8 a 12".

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

export default function AlunoTreinos({ aluno }) {
  const [treinos, setTreinos] = useState(null)
  const [itens, setItens] = useState({})
  const [semana, setSemana] = useState(null)
  const [aberto, setAberto] = useState(null)

  useEffect(() => {
    (async () => {
      const { data: trs } = await supabase
        .from('academia_treinos')
        .select('*')
        .eq('aluno_id', aluno.id)
        .eq('ativo', true)
        .order('letra')
      setTreinos(trs || [])
      if (trs?.length) {
        const { data: its } = await supabase
          .from('academia_treino_itens')
          .select('*')
          .in('treino_id', trs.map(t => t.id))
          .order('ordem')
        const porTreino = {}
        ;(its || []).forEach(i => { (porTreino[i.treino_id] ||= []).push(i) })
        setItens(porTreino)
        const hoje = DIAS[new Date().getDay()]
        setAberto(trs.find(t => t.dia_semana === hoje)?.id || trs[0].id)
      }
      const { data: semanas } = await supabase
        .from('academia_semanas')
        .select('*')
        .eq('aluno_id', aluno.id)
        .order('numero')
      // Semana "de agora": a primeira que o professor montou é a 1; sem
      // controle de data ainda, mostramos a primeira preenchida.
      setSemana((semanas || [])[0] || null)
    })()
  }, [aluno.id])

  if (treinos === null) return <p className="al-vazio">Carregando...</p>

  if (treinos.length === 0) {
    return (
      <section className="al-bloco">
        <p className="al-texto">Seu treino ainda não foi montado. Fale com o professor.</p>
      </section>
    )
  }

  const hoje = DIAS[new Date().getDay()]
  const doDia = treinos.find(t => t.dia_semana === hoje)

  return (
    <>
      {doDia ? (
        <section className="al-hoje">
          <span className="al-rotulo">Hoje é {hoje.toLowerCase()}</span>
          <strong>Treino {doDia.letra}</strong>
          <span className="al-sub">{(itens[doDia.id] || []).length} exercícios</span>
        </section>
      ) : (
        <section className="al-bloco">
          <p className="al-texto">Hoje você não tem treino marcado. Escolha um abaixo.</p>
        </section>
      )}

      <div className="al-letras">
        {treinos.map(t => (
          <button
            key={t.id}
            className={`al-letra${aberto === t.id ? ' ativa' : ''} tem`}
            onClick={() => setAberto(t.id)}
          >
            {t.letra}
            <small>{t.dia_semana || '—'}</small>
          </button>
        ))}
      </div>

      {treinos.filter(t => t.id === aberto).map(t => (
        <section key={t.id} className="al-bloco">
          <h2>Treino {t.letra}{t.dia_semana ? ` · ${t.dia_semana}` : ''}</h2>
          {semana && (
            <p className="al-semana">
              {semana.series ? `${semana.series} séries` : ''}
              {semana.rep_min ? ` de ${semana.rep_min}${semana.rep_max ? ` a ${semana.rep_max}` : ''} repetições` : ''}
              {semana.sistema ? ` · ${semana.sistema}` : ''}
            </p>
          )}
          <ul className="al-itens-aluno">
            {(itens[t.id] || []).map((i, n) => (
              <li key={i.id}>
                <span className="al-item-num">{n + 1}</span>
                <span className="al-item-nome">
                  <strong>{i.nome}{i.variacao ? ` (${i.variacao})` : ''}</strong>
                  <small>{i.maquina ? `máquina ${i.maquina}` : 'peso livre'}</small>
                </span>
                {i.maquina && <span className="al-maquina">{i.maquina}</span>}
              </li>
            ))}
            {(itens[t.id] || []).length === 0 && <li className="al-vazio">Sem exercícios ainda.</li>}
          </ul>
        </section>
      ))}
    </>
  )
}
