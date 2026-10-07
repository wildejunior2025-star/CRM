import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'

// O professor monta o treino do aluno pelo celular, do mesmo jeito que fazia
// no cartão: escolhe os treinos A a E, marca o dia e vai marcando os
// exercícios de cada grupo. O número da máquina vem junto.

const LETRAS = ['A', 'B', 'C', 'D', 'E']
const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const VARIACOES = ['', 'H', 'UNI', 'ABERTO', 'CROSS']

export default function ProfessorTreino({ aluno, onVoltar }) {
  const { profile } = useAuth()
  const [exercicios, setExercicios] = useState([])
  const [treinos, setTreinos] = useState([])
  const [itens, setItens] = useState({}) // treino_id → itens
  const [letra, setLetra] = useState('A')
  const [escolhendo, setEscolhendo] = useState(false)
  // Criar exercício na hora: no cartão de papel ele escrevia à mão os que não
  // estavam na lista (Sumô, Búlgaro, Afundo/Step).
  const [novo, setNovo] = useState(null) // { nome, grupo, maquina }
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    const [{ data: exs }, { data: trs }] = await Promise.all([
      supabase.from('academia_exercicios').select('*').eq('empresa_id', profile.empresa_id)
        .eq('ativo', true).order('grupo').order('ordem'),
      supabase.from('academia_treinos').select('*').eq('aluno_id', aluno.id).order('letra'),
    ])
    setExercicios(exs || [])
    setTreinos(trs || [])
    if (trs?.length) {
      const { data: its } = await supabase
        .from('academia_treino_itens').select('*')
        .in('treino_id', trs.map(t => t.id)).order('ordem')
      const porTreino = {}
      ;(its || []).forEach(i => { (porTreino[i.treino_id] ||= []).push(i) })
      setItens(porTreino)
    } else {
      setItens({})
    }
  }, [aluno.id, profile.empresa_id])

  useEffect(() => { carregar() }, [carregar])

  const treino = treinos.find(t => t.letra === letra)
  const lista = treino ? (itens[treino.id] || []) : []

  async function garantirTreino() {
    if (treino) return treino
    const { data, error } = await supabase
      .from('academia_treinos')
      .insert({ empresa_id: profile.empresa_id, aluno_id: aluno.id, letra, criado_por: profile.id })
      .select()
      .single()
    if (error) { setErro(error.message); return null }
    setTreinos(t => [...t, data])
    return data
  }

  async function adicionar(ex) {
    setSalvando(true)
    setErro(null)
    const t = await garantirTreino()
    if (!t) { setSalvando(false); return }
    const { error } = await supabase.from('academia_treino_itens').insert({
      treino_id: t.id,
      exercicio_id: ex.id,
      nome: ex.nome,
      maquina: ex.maquina,
      ordem: (itens[t.id]?.length || 0) + 1,
    })
    setSalvando(false)
    if (error) return setErro(error.message)
    carregar()
  }

  // Exercício que não existe na lista: cria no catálogo da academia e já põe
  // no treino. Da próxima vez ele aparece pra todo mundo.
  async function criarExercicio(e) {
    e.preventDefault()
    if (!novo.nome.trim()) return setErro('Dê um nome ao exercício.')
    setSalvando(true)
    setErro(null)
    const { data, error } = await supabase
      .from('academia_exercicios')
      .insert({
        empresa_id: profile.empresa_id,
        grupo: novo.grupo,
        nome: novo.nome.trim(),
        maquina: novo.maquina.trim() || null,
        ordem: 99,
      })
      .select()
      .single()
    if (error) { setSalvando(false); return setErro(error.message) }
    setExercicios(l => [...l, data])
    setNovo(null)
    await adicionar(data)
  }

  async function remover(item) {
    await supabase.from('academia_treino_itens').delete().eq('id', item.id)
    carregar()
  }

  async function mudarVariacao(item, variacao) {
    await supabase.from('academia_treino_itens').update({ variacao: variacao || null }).eq('id', item.id)
    carregar()
  }

  async function mudarDia(dia) {
    const t = await garantirTreino()
    if (!t) return
    await supabase.from('academia_treinos').update({ dia_semana: dia || null }).eq('id', t.id)
    carregar()
  }

  async function apagarTreino() {
    if (!treino) return
    if (!window.confirm(`Apagar o treino ${letra} de ${aluno.nome.split(' ')[0]}?`)) return
    await supabase.from('academia_treinos').delete().eq('id', treino.id)
    carregar()
  }

  const porGrupo = exercicios.reduce((acc, e) => { (acc[e.grupo] ||= []).push(e); return acc }, {})
  const jaTem = new Set(lista.map(i => i.exercicio_id))

  if (escolhendo) {
    return (
      <div className="al-tela">
        <header className="al-topo">
          <div className="al-titulo">
            <span className="al-ola">Treino {letra}</span>
            <h1>Escolher exercício</h1>
          </div>
          <button className="al-menu-botao" onClick={() => setEscolhendo(false)}>✕</button>
        </header>

        {novo ? (
          <form className="al-bloco" onSubmit={criarExercicio}>
            <h2>Exercício novo</h2>
            <label className="al-campo">Nome
              <input autoFocus value={novo.nome} onChange={e => setNovo({ ...novo, nome: e.target.value })} placeholder="Ex.: Agachamento Búlgaro" />
            </label>
            <label className="al-campo">Grupo
              <select value={novo.grupo} onChange={e => setNovo({ ...novo, grupo: e.target.value })}>
                {Object.keys(porGrupo).map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </label>
            <label className="al-campo">Número da máquina
              <input inputMode="numeric" value={novo.maquina} onChange={e => setNovo({ ...novo, maquina: e.target.value })} placeholder="deixe vazio se for peso livre" />
            </label>
            {erro && <div className="al-erro">{erro}</div>}
            <button className="al-botao" disabled={salvando}>{salvando ? 'Criando...' : 'Criar e adicionar'}</button>
            <button type="button" className="al-botao texto" onClick={() => { setNovo(null); setErro(null) }}>Cancelar</button>
          </form>
        ) : (
          <button className="al-botao secundario" onClick={() => setNovo({ nome: '', grupo: Object.keys(porGrupo)[0] || 'Pernas', maquina: '' })}>
            + Criar exercício que não está na lista
          </button>
        )}

        {Object.entries(porGrupo).map(([grupo, exs]) => (
          <section key={grupo} className="al-bloco">
            <h2>{grupo}</h2>
            <div className="al-exercicios">
              {exs.map(ex => (
                <button
                  key={ex.id}
                  className={`al-exercicio${jaTem.has(ex.id) ? ' marcado' : ''}`}
                  disabled={salvando}
                  onClick={() => adicionar(ex)}
                >
                  <span>{ex.nome}</span>
                  <small>{ex.maquina ? `máq. ${ex.maquina}` : 'peso livre'}</small>
                </button>
              ))}
            </div>
          </section>
        ))}

        <footer className="al-rodape">
          <button className="al-botao" onClick={() => setEscolhendo(false)}>Pronto</button>
        </footer>
      </div>
    )
  }

  return (
    <div className="al-tela">
      <header className="al-topo">
        <button className="al-menu-botao" onClick={onVoltar} aria-label="Voltar">←</button>
        <div className="al-titulo">
          <span className="al-ola">{aluno.matricula ? `nº ${aluno.matricula}` : 'Aluno'}</span>
          <h1>{aluno.nome.split(' ').slice(0, 2).join(' ')}</h1>
        </div>
        {aluno.foto && <img className="al-foto" src={aluno.foto} alt="" />}
      </header>

      {(aluno.diabetes || aluno.hipertensao || aluno.cardiopata || aluno.saude_outra) && (
        <div className="al-alerta-saude">
          ⚠ {[aluno.diabetes && 'diabetes', aluno.hipertensao && 'hipertensão', aluno.cardiopata && 'cardiopata', aluno.saude_outra]
            .filter(Boolean).join(' · ')}
        </div>
      )}

      <div className="al-letras">
        {LETRAS.map(l => {
          const t = treinos.find(x => x.letra === l)
          return (
            <button key={l} className={`al-letra${letra === l ? ' ativa' : ''}${t ? ' tem' : ''}`} onClick={() => setLetra(l)}>
              {l}
              <small>{t?.dia_semana || (t ? `${(itens[t.id] || []).length}` : '—')}</small>
            </button>
          )
        })}
      </div>

      <div className="al-dias">
        {DIAS.map(d => (
          <button
            key={d}
            className={`al-dia${treino?.dia_semana === d ? ' ativo' : ''}`}
            onClick={() => mudarDia(treino?.dia_semana === d ? '' : d)}
          >{d}</button>
        ))}
      </div>

      {erro && <div className="al-erro">{erro}</div>}

      {lista.length === 0 ? (
        <section className="al-bloco">
          <p className="al-vazio">Treino {letra} ainda vazio. Toque em "Adicionar exercício".</p>
        </section>
      ) : (
        <section className="al-bloco">
          <ul className="al-itens">
            {lista.map((i, n) => (
              <li key={i.id}>
                <span className="al-item-num">{n + 1}</span>
                <span className="al-item-nome">
                  <strong>{i.nome}</strong>
                  <small>{i.maquina ? `máquina ${i.maquina}` : 'peso livre'}</small>
                </span>
                <select value={i.variacao || ''} onChange={e => mudarVariacao(i, e.target.value)}>
                  {VARIACOES.map(v => <option key={v} value={v}>{v || '—'}</option>)}
                </select>
                <button className="al-item-x" onClick={() => remover(i)} aria-label="Tirar">✕</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="al-rodape">
        <button className="al-botao" onClick={() => setEscolhendo(true)}>+ Adicionar exercício</button>
        {treino && <button className="al-botao texto" onClick={apagarTreino}>Apagar treino {letra}</button>}
      </footer>
    </div>
  )
}
