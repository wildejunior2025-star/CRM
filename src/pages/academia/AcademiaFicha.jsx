import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { dataBr, hojeIso } from '../../lib/academiaPagamento'

// Ficha do aluno — é o verso do cartão de papel da academia:
// saúde (diabetes, hipertensão, cardiopata, outra) e a avaliação física com
// as medidas. A diferença é que aqui cada medição fica guardada, então o
// professor compara com a anterior e mostra a evolução pro aluno.

const MEDIDAS = [
  { id: 'peso', nome: 'Peso', unidade: 'kg' },
  { id: 'estatura', nome: 'Estatura', unidade: 'cm' },
  { id: 'peitoral', nome: 'Peitoral', unidade: 'cm' },
  { id: 'ombro', nome: 'Ombro', unidade: 'cm' },
  { id: 'cintura', nome: 'Cintura', unidade: 'cm' },
  { id: 'quadril', nome: 'Quadril', unidade: 'cm' },
  { id: 'braco_dir', nome: 'Braço direito', unidade: 'cm' },
  { id: 'braco_esq', nome: 'Braço esquerdo', unidade: 'cm' },
  { id: 'antebraco_dir', nome: 'Antebraço direito', unidade: 'cm' },
  { id: 'antebraco_esq', nome: 'Antebraço esquerdo', unidade: 'cm' },
  { id: 'coxa_dir', nome: 'Coxa direita', unidade: 'cm' },
  { id: 'coxa_esq', nome: 'Coxa esquerda', unidade: 'cm' },
  { id: 'panturrilha_dir', nome: 'Panturrilha direita', unidade: 'cm' },
  { id: 'panturrilha_esq', nome: 'Panturrilha esquerda', unidade: 'cm' },
]

const num = v => (v === '' || v === null || v === undefined ? null : Number(String(v).replace(',', '.')))
const mostra = v => (v === null || v === undefined ? '—' : String(v).replace('.', ','))

function idadeDe(nascimento) {
  if (!nascimento) return null
  const n = new Date(nascimento + 'T00:00:00')
  const hoje = new Date()
  let i = hoje.getFullYear() - n.getFullYear()
  const m = hoje.getMonth() - n.getMonth()
  if (m < 0 || (m === 0 && hoje.getDate() < n.getDate())) i--
  return i
}

export default function AcademiaFicha({ aluno, onVoltar }) {
  const { empresa } = useAuth()
  const [saude, setSaude] = useState({
    diabetes: aluno.diabetes, hipertensao: aluno.hipertensao, cardiopata: aluno.cardiopata,
    saude_outra: aluno.saude_outra || '', objetivo: aluno.objetivo || '',
    nascimento: aluno.nascimento || '', sexo: aluno.sexo || '',
  })
  const [salvandoSaude, setSalvandoSaude] = useState(false)
  const [salvoSaude, setSalvoSaude] = useState(false)
  const [avaliacoes, setAvaliacoes] = useState([])
  const [medindo, setMedindo] = useState(false)
  const [medidas, setMedidas] = useState({ data: hojeIso() })
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const carregar = useCallback(async () => {
    const { data } = await supabase
      .from('academia_avaliacoes')
      .select('*')
      .eq('aluno_id', aluno.id)
      .order('data', { ascending: false })
    setAvaliacoes(data || [])
  }, [aluno.id])

  useEffect(() => { carregar() }, [carregar])

  async function salvarSaude(e) {
    e.preventDefault()
    setSalvandoSaude(true)
    setErro(null)
    const { error } = await supabase
      .from('academia_alunos')
      .update({
        diabetes: saude.diabetes,
        hipertensao: saude.hipertensao,
        cardiopata: saude.cardiopata,
        saude_outra: saude.saude_outra.trim() || null,
        objetivo: saude.objetivo.trim() || null,
        nascimento: saude.nascimento || null,
        sexo: saude.sexo || null,
      })
      .eq('id', aluno.id)
    setSalvandoSaude(false)
    if (error) return setErro('Não salvou: ' + error.message)
    Object.assign(aluno, saude)
    setSalvoSaude(true)
    setTimeout(() => setSalvoSaude(false), 2500)
  }

  async function salvarAvaliacao(e) {
    e.preventDefault()
    const linha = { empresa_id: empresa.id, aluno_id: aluno.id, data: medidas.data || hojeIso() }
    MEDIDAS.forEach(m => { linha[m.id] = num(medidas[m.id]) })
    linha.observacao = medidas.observacao?.trim() || null
    if (MEDIDAS.every(m => linha[m.id] === null)) return setErro('Preencha pelo menos uma medida.')
    setSalvando(true)
    setErro(null)
    const { data: user } = await supabase.auth.getUser()
    const { error } = await supabase.from('academia_avaliacoes').insert({ ...linha, criado_por: user?.user?.id ?? null })
    setSalvando(false)
    if (error) return setErro('Não salvou: ' + error.message)
    setMedindo(false)
    setMedidas({ data: hojeIso() })
    carregar()
  }

  async function apagar(av) {
    if (!window.confirm(`Apagar a avaliação de ${dataBr(av.data)}?`)) return
    await supabase.from('academia_avaliacoes').delete().eq('id', av.id)
    carregar()
  }

  const ultima = avaliacoes[0]
  const anterior = avaliacoes[1]
  const idade = idadeDe(saude.nascimento)

  return (
    <div>
      <div className="ac-linha-titulo">
        <h2>
          Ficha de {aluno.nome}
          {aluno.matricula && <span className="ac-muted"> · matrícula {aluno.matricula}</span>}
        </h2>
        <button className="btn btn-secondary btn-sm" onClick={onVoltar}>Voltar</button>
      </div>

      <form className="ac-card ac-form" onSubmit={salvarSaude} style={{ marginBottom: 16 }}>
        <h3 className="ac-sub-titulo">Saúde e objetivo</h3>
        <div className="ac-ficha-grade">
          <label>Nascimento
            <input type="date" value={saude.nascimento} onChange={e => setSaude({ ...saude, nascimento: e.target.value })} />
          </label>
          <label>Idade
            <input value={idade ?? ''} readOnly placeholder="—" />
          </label>
          <label>Sexo
            <select value={saude.sexo} onChange={e => setSaude({ ...saude, sexo: e.target.value })}>
              <option value="">—</option>
              <option value="M">Masculino</option>
              <option value="F">Feminino</option>
            </select>
          </label>
          <label>Objetivo
            <input value={saude.objetivo} onChange={e => setSaude({ ...saude, objetivo: e.target.value })} placeholder="Emagrecer, ganhar massa..." />
          </label>
        </div>

        <div className="ac-marcacoes">
          {[
            ['diabetes', 'Diabetes'],
            ['hipertensao', 'Hipertensão'],
            ['cardiopata', 'Cardiopata'],
          ].map(([id, nome]) => (
            <label key={id} className="ac-check">
              <input type="checkbox" checked={!!saude[id]} onChange={e => setSaude({ ...saude, [id]: e.target.checked })} />
              {nome}
            </label>
          ))}
          <label className="ac-outra">Outra
            <input value={saude.saude_outra} onChange={e => setSaude({ ...saude, saude_outra: e.target.value })} placeholder="Asma, lesão no joelho..." />
          </label>
        </div>

        <div className="ac-form-botoes">
          <button className="btn btn-primary" disabled={salvandoSaude}>
            {salvandoSaude ? 'Salvando...' : salvoSaude ? 'Salvo ✓' : 'Salvar saúde'}
          </button>
        </div>
      </form>

      <div className="ac-linha-titulo">
        <h3 className="ac-sub-titulo">Avaliação física <span className="ac-muted">({avaliacoes.length})</span></h3>
        {!medindo && <button className="btn btn-primary" onClick={() => setMedindo(true)}>+ Nova avaliação</button>}
      </div>

      {erro && <div className="ac-erro" style={{ marginBottom: 12 }}>{erro}</div>}

      {medindo && (
        <form className="ac-card ac-form" onSubmit={salvarAvaliacao} style={{ marginBottom: 16 }}>
          <label style={{ maxWidth: 220 }}>Data da medição
            <input type="date" value={medidas.data} onChange={e => setMedidas({ ...medidas, data: e.target.value })} />
          </label>
          <div className="ac-ficha-grade">
            {MEDIDAS.map(m => (
              <label key={m.id}>{m.nome} <span className="ac-muted">({m.unidade})</span>
                <input
                  inputMode="decimal" value={medidas[m.id] ?? ''}
                  onChange={e => setMedidas({ ...medidas, [m.id]: e.target.value })}
                  placeholder={ultima?.[m.id] != null ? `antes: ${mostra(ultima[m.id])}` : ''}
                />
              </label>
            ))}
          </div>
          <label>Observação
            <input value={medidas.observacao ?? ''} onChange={e => setMedidas({ ...medidas, observacao: e.target.value })} />
          </label>
          <div className="ac-form-botoes">
            <button type="button" className="btn btn-secondary" onClick={() => { setMedindo(false); setErro(null) }}>Cancelar</button>
            <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar avaliação'}</button>
          </div>
        </form>
      )}

      {avaliacoes.length === 0 ? (
        <p className="ac-muted">Nenhuma avaliação ainda.</p>
      ) : (
        <div className="ac-tabela-caixa">
          <table className="ac-tabela">
            <thead>
              <tr>
                <th>Medida</th>
                <th className="ac-num">Agora<br /><span className="ac-muted">{dataBr(ultima.data)}</span></th>
                {anterior && <th className="ac-num">Antes<br /><span className="ac-muted">{dataBr(anterior.data)}</span></th>}
                {anterior && <th className="ac-num">Diferença</th>}
              </tr>
            </thead>
            <tbody>
              {MEDIDAS.filter(m => ultima[m.id] != null || anterior?.[m.id] != null).map(m => {
                const agora = ultima[m.id]
                const antes = anterior?.[m.id]
                const dif = agora != null && antes != null ? Number(agora) - Number(antes) : null
                return (
                  <tr key={m.id}>
                    <td data-rotulo="Medida">{m.nome} <span className="ac-muted">({m.unidade})</span></td>
                    <td data-rotulo="Agora" className="ac-num"><strong>{mostra(agora)}</strong></td>
                    {anterior && <td data-rotulo="Antes" className="ac-num">{mostra(antes)}</td>}
                    {anterior && (
                      <td data-rotulo="Diferença" className="ac-num">
                        {dif === null ? '—' : (
                          <span className={dif > 0 ? 'ac-subiu' : dif < 0 ? 'ac-desceu' : ''}>
                            {dif > 0 ? '+' : ''}{String(dif.toFixed(1)).replace('.', ',')}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {avaliacoes.length > 1 && (
        <div style={{ marginTop: 14 }}>
          <h3 className="ac-sub-titulo">Todas as medições</h3>
          <div className="ac-lista">
            {avaliacoes.map(av => (
              <div key={av.id} className="ac-aluno">
                <div className="ac-aluno-info">
                  <strong>{dataBr(av.data)}</strong>
                  <span className="ac-muted">
                    {MEDIDAS.filter(m => av[m.id] != null).map(m => `${m.nome.split(' ')[0]} ${mostra(av[m.id])}`).join(' · ') || 'sem medidas'}
                  </span>
                  {av.observacao && <span className="ac-muted">{av.observacao}</span>}
                </div>
                <div className="ac-aluno-acoes">
                  <button className="btn btn-secondary btn-sm" onClick={() => apagar(av)}>Apagar</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
