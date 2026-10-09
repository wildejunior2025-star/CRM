import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'
import { situacaoAluno, entrarTelaCheia } from '../../lib/reconhecimentoFacial'
import { FORMAS, hojeIso, somarMeses, registrarPagamento, dinheiro, dataBr } from '../../lib/academiaPagamento'
import CapturaRosto from './CapturaRosto'
import AcademiaFicha from './AcademiaFicha'


function hojeMais(dias) {
  const d = new Date()
  d.setDate(d.getDate() + dias)
  return d.toISOString().slice(0, 10)
}

const VAZIO = { nome: '', telefone: '', plano: 'Mensal', valor: '', vencimento: '', ativo: true }

export default function AcademiaAlunos() {
  const { empresa } = useAuth()
  const [alunos, setAlunos] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [busca, setBusca] = useState('')
  const [editando, setEditando] = useState(null) // null | 'novo' | aluno
  const [recebendo, setRecebendo] = useState(null) // aluno a quem registrar a mensalidade
  const [ficha, setFicha] = useState(null) // aluno cuja ficha (saúde + medidas) está aberta
  const [filtro, setFiltro] = useState('todos') // todos | emdia | vencidos | semrosto

  async function carregar() {
    const { data, error } = await supabase
      .from('academia_alunos')
      .select('*')
      .eq('empresa_id', empresa.id)
      .order('nome')
    if (!error) setAlunos(data || [])
    setCarregando(false)
  }

  useEffect(() => { carregar() }, [empresa.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Busca por nome OU matrícula: na recepção eles chamam o aluno pelo número.
  const termo = busca.trim().toLowerCase()
  const hoje = hojeMais(0)
  const emDia = a => a.ativo && (!a.vencimento || a.vencimento >= hoje)
  // Quem não treina mais fica FORA das contas do dia a dia. São os 579 que
  // vieram do sistema antigo (pararam de pagar de 2 a 12 meses atrás): ficam
  // guardados pra quando um deles voltar — a recepção acha pela busca e só
  // aperta Renovar —, mas não podem inchar "Todos" nem "Vencidos".
  const daCasa = alunos.filter(a => a.ativo)
  const contas = {
    todos: daCasa.length,
    emdia: daCasa.filter(emDia).length,
    vencidos: daCasa.filter(a => !emDia(a)).length,
    semrosto: daCasa.filter(a => !a.descritores?.length).length,
    inativos: alunos.length - daCasa.length,
  }
  // Procurando pelo nome, procura em TODO MUNDO: a pessoa está no balcão e
  // ninguém sabe de cabeça se ela consta como ativa.
  const procurando = termo.length > 0
  const base = procurando || filtro === 'inativos' ? alunos : daCasa
  const filtrados = base
    .filter(a => a.nome.toLowerCase().includes(termo) || String(a.matricula || '').toLowerCase().includes(termo))
    .filter(a => procurando
      || filtro === 'todos'
      || (filtro === 'emdia' && emDia(a))
      || (filtro === 'vencidos' && !emDia(a))
      || (filtro === 'semrosto' && !a.descritores?.length)
      || (filtro === 'inativos' && !a.ativo))
  const semRosto = contas.semrosto

  if (ficha) {
    return <AcademiaFicha aluno={ficha} onVoltar={() => { setFicha(null); carregar() }} />
  }

  if (editando) {
    return (
      <FormAluno
        aluno={editando === 'novo' ? null : editando}
        alunos={alunos}
        empresaId={empresa.id}
        onFechar={salvou => { setEditando(null); if (salvou) carregar() }}
      />
    )
  }

  return (
    <div>
      {recebendo && (
        <ReceberMensalidade
          aluno={recebendo}
          empresaId={empresa.id}
          onFechar={pago => { setRecebendo(null); if (pago) carregar() }}
        />
      )}
      <div className="ac-linha-titulo">
        <h2>Alunos</h2>
        <button className="btn btn-primary" onClick={() => setEditando('novo')}>+ Novo aluno</button>
      </div>

      <div className="ac-barra">
        <input className="ac-busca" placeholder="Buscar pelo nome ou matrícula"
          value={busca} onChange={e => setBusca(e.target.value)} />
        <div className="ac-filtros">
          {[
            { id: 'todos', nome: 'Todos' },
            { id: 'emdia', nome: 'Em dia' },
            { id: 'vencidos', nome: 'Vencidos' },
            { id: 'semrosto', nome: 'Sem rosto' },
            { id: 'inativos', nome: 'Sumidos' },
          ].map(f => (
            <button key={f.id} type="button"
              className={`ac-filtro${filtro === f.id ? ' ativo' : ''}${f.id === 'vencidos' && contas.vencidos ? ' alerta' : ''}`}
              onClick={() => setFiltro(f.id)}>
              {f.nome} <b>{contas[f.id]}</b>
            </button>
          ))}
        </div>
      </div>

      {carregando ? <p className="ac-muted">Carregando...</p> : filtrados.length === 0 ? (
        <p className="ac-muted">{alunos.length ? 'Ninguém com esse nome.' : 'Nenhum aluno ainda. Cadastre o primeiro.'}</p>
      ) : (
        <div className="ac-tabela-caixa">
          <table className="ac-tabela">
            <thead>
              <tr>
                <th>Matrícula</th>
                <th>Nome</th>
                <th>Plano</th>
                <th className="ac-num">Valor</th>
                <th>Vence em</th>
                <th>Situação</th>
                <th className="ac-col-acoes"></th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(a => {
                const s = situacaoAluno(a)
                return (
                  <tr key={a.id}>
                    <td data-rotulo="Matrícula" className="ac-num">{a.matricula || '—'}</td>
                    <td data-rotulo="Nome">
                      <span className="ac-nome-com-foto">
                        {a.foto
                          ? <img src={a.foto} alt="" className="ac-foto" />
                          : <span className="ac-foto ac-foto-vazia" title="Sem rosto cadastrado">?</span>}
                        <strong>{a.nome}</strong>
                      </span>
                    </td>
                    <td data-rotulo="Plano" className="ac-muted">{a.plano || '—'}</td>
                    <td data-rotulo="Valor" className="ac-num">{a.valor ? dinheiro(a.valor) : '—'}</td>
                    <td data-rotulo="Vence em" className="ac-num">{a.vencimento ? dataBr(a.vencimento) : '—'}</td>
                    <td data-rotulo="Situação">
                      <span className={`ac-status ac-${s.status}${s.aviso ? ' ac-quase' : ''}`}>{s.texto}</span>
                      {!a.descritores?.length && <span className="ac-status ac-vencido">Sem rosto</span>}
                    </td>
                    <td className="ac-col-acoes">
                      <button className="btn btn-secondary btn-sm" onClick={() => setRecebendo(a)} title="Registrar mensalidade paga">Renovar</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setFicha(a)}>Ficha</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditando(a)}>Editar</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {semRosto > 0 && filtro !== 'semrosto' && (
        <p className="ac-muted" style={{ marginTop: 10 }}>
          {semRosto} aluno{semRosto > 1 ? 's' : ''} sem rosto cadastrado — a recepção não reconhece esse pessoal ainda.
        </p>
      )}
    </div>
  )
}

function FormAluno({ aluno, alunos, empresaId, onFechar }) {
  const [dados, setDados] = useState(() => aluno ? {
    nome: aluno.nome, telefone: aluno.telefone || '', plano: aluno.plano || '',
    valor: aluno.valor ?? '', vencimento: aluno.vencimento || '', ativo: aluno.ativo,
  } : { ...VAZIO, vencimento: hojeMais(30) })
  const [rosto, setRosto] = useState(null) // { descritores, foto } capturado agora
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)
  const [cameraAberta, setCameraAberta] = useState(false)

  const set = (k, v) => setDados(d => ({ ...d, [k]: v }))
  const fotoAtual = rosto?.foto || aluno?.foto

  async function salvar(e) {
    e.preventDefault()
    setErro(null)
    if (!dados.nome.trim()) return setErro('Coloque o nome.')
    setSalvando(true)
    const linha = {
      empresa_id: empresaId,
      nome: dados.nome.trim(),
      telefone: dados.telefone.trim() || null,
      plano: dados.plano.trim() || null,
      valor: dados.valor === '' ? null : Number(String(dados.valor).replace(',', '.')),
      vencimento: dados.vencimento || null,
      ativo: dados.ativo,
    }
    // Empurrou o vencimento pra frente num aluno inativo? Ele voltou. Quem
    // mexe na data de um sumido está reativando, não anotando curiosidade —
    // e ninguém lembra de procurar a caixinha "Matrícula ativa" lá embaixo.
    // Só vale quando a data MUDOU: desmarcar a caixa sem tocar na data
    // continua desativando quem está em dia (aluno suspenso, por exemplo).
    const mudouData = !!dados.vencimento && dados.vencimento !== (aluno?.vencimento || '')
    if (aluno && !dados.ativo && mudouData && dados.vencimento >= hojeIso()) {
      linha.ativo = true
    }
    if (rosto) {
      linha.descritores = rosto.descritores
      linha.foto = rosto.foto
      // O aceite da LGPD é do ALUNO, na primeira vez que ele entra no app
      // (o dono marcando uma caixinha aqui não valia nada).
    }
    const { error } = aluno
      ? await supabase.from('academia_alunos').update(linha).eq('id', aluno.id)
      : await supabase.from('academia_alunos').insert(linha)
    setSalvando(false)
    if (error) return setErro('Não salvou: ' + error.message)
    onFechar(true)
  }

  // Aluno esqueceu a senha: volta a ser os 4 últimos dígitos do celular dele.
  async function redefinirSenha() {
    setErro(null)
    const { data, error } = await supabase.rpc('academia_resetar_senha', { p_aluno_id: aluno.id })
    if (error) return setErro(error.message)
    window.alert(`Senha redefinida. A nova senha de ${aluno.nome} é ${data} (os 4 últimos dígitos do celular dele).`)
  }

  async function apagar() {
    if (!window.confirm(`Apagar ${aluno.nome}? Some o cadastro, o rosto e o histórico de entradas.`)) return
    await supabase.from('academia_alunos').delete().eq('id', aluno.id)
    onFechar(true)
  }

  return (
    <form className="ac-card ac-form" onSubmit={salvar}>
      <div className="ac-linha-titulo">
        <h2>{aluno ? 'Editar aluno' : 'Novo aluno'}</h2>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onFechar(false)}>Voltar</button>
      </div>

      <div className="ac-form-grade">
        <div className="ac-form-rosto">
          {cameraAberta && (
            <CapturaRosto
              alunos={alunos.filter(a => a.id !== aluno?.id)}
              onPronto={r => { setRosto(r); setCameraAberta(false) }}
              onCancelar={() => setCameraAberta(false)}
            />
          )}
          <div className="ac-rosto-pronto">
            {fotoAtual ? <img src={fotoAtual} alt="" /> : <div className="ac-foto ac-foto-vazia grande">?</div>}
            {rosto && <span className="ac-status ac-liberado">Rosto capturado ✓</span>}
            <button type="button" className={`btn ${fotoAtual ? 'btn-secondary btn-sm' : 'btn-primary'}`} onClick={() => { entrarTelaCheia(); setCameraAberta(true) }}>
              {fotoAtual ? 'Tirar de novo' : '📷 Cadastrar rosto'}
            </button>
          </div>
        </div>

        <div className="ac-form-campos">
          <label>Nome
            <input value={dados.nome} onChange={e => set('nome', e.target.value)} required />
          </label>
          <label>WhatsApp
            <input inputMode="tel" value={dados.telefone} onChange={e => set('telefone', e.target.value)} placeholder="(84) 99999-9999" />
          </label>
          <div className="ac-dupla">
            <label>Plano
              <input value={dados.plano} onChange={e => set('plano', e.target.value)} placeholder="Mensal" />
            </label>
            <label>Valor (R$)
              <input inputMode="decimal" value={dados.valor} onChange={e => set('valor', e.target.value)} placeholder="89,90" />
            </label>
          </div>
          <label>Vence em
            <input type="date" value={dados.vencimento} onChange={e => set('vencimento', e.target.value)} />
          </label>
          {aluno && (
            <label className="ac-check">
              <input type="checkbox" checked={dados.ativo} onChange={e => set('ativo', e.target.checked)} />
              Matrícula ativa
            </label>
          )}
          {aluno && !dados.ativo && (
            <p className="ac-aviso">
              Desligada, a catraca não abre pra ela nem com a mensalidade em dia.
              Se ela voltou, marque a caixa acima — ou aperte <b>Renovar</b> na lista,
              que recebe a mensalidade e religa de uma vez.
            </p>
          )}
        </div>
      </div>

      {erro && <div className="ac-erro">{erro}</div>}
      <div className="ac-form-botoes">
        {aluno && <button type="button" className="btn btn-danger" onClick={apagar}>Apagar</button>}
        {aluno && <button type="button" className="btn btn-secondary" onClick={redefinirSenha}>Redefinir senha do app</button>}
        <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando...' : 'Salvar'}</button>
      </div>
    </form>
  )
}


// Telinha do "Renovar": registra a mensalidade paga e empurra o vencimento.
function ReceberMensalidade({ aluno, empresaId, onFechar }) {
  const [valor, setValor] = useState(String(aluno.valor ?? '').replace('.', ','))
  const [forma, setForma] = useState('dinheiro')
  const [meses, setMeses] = useState(1)
  const [data, setData] = useState(hojeIso())
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState(null)

  const novoVencimento = somarMeses(aluno.vencimento, meses, data)

  async function confirmar(e) {
    e.preventDefault()
    const v = Number(String(valor).replace(',', '.'))
    if (!v || v <= 0) return setErro('Coloque o valor que o aluno pagou.')
    setSalvando(true)
    setErro(null)
    try {
      await registrarPagamento({ empresaId, aluno, valor: v, forma, meses, data })
      onFechar(true)
    } catch (err) {
      setErro('Não deu pra registrar: ' + err.message)
      setSalvando(false)
    }
  }

  return (
    <div className="ac-modal" role="dialog" aria-modal="true">
      <form className="ac-card ac-form ac-modal-caixa" onSubmit={confirmar}>
        <h2>Mensalidade de {aluno.nome.split(' ')[0]}</h2>
        <p className="ac-muted">
          Vence {aluno.vencimento ? dataBr(aluno.vencimento) : 'sem data'} → passa a vencer <b>{dataBr(novoVencimento)}</b>
        </p>

        <div className="ac-dupla">
          <label>Valor pago
            <input inputMode="decimal" value={valor} onChange={e => setValor(e.target.value)} autoFocus />
          </label>
          <label>Meses
            <select value={meses} onChange={e => setMeses(Number(e.target.value))}>
              {[1, 2, 3, 6, 12].map(m => <option key={m} value={m}>{m} {m === 1 ? 'mês' : 'meses'}</option>)}
            </select>
          </label>
        </div>

        <label>Forma de pagamento
          <select value={forma} onChange={e => setForma(e.target.value)}>
            {FORMAS.map(f => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </select>
        </label>

        <label>Data do pagamento
          <input type="date" value={data} onChange={e => setData(e.target.value)} />
        </label>

        {erro && <div className="ac-erro">{erro}</div>}

        <div className="ac-form-botoes">
          <button type="button" className="btn btn-secondary" onClick={() => onFechar(false)} disabled={salvando}>Cancelar</button>
          <button className="btn btn-primary" disabled={salvando}>{salvando ? 'Salvando...' : 'Confirmar pagamento'}</button>
        </div>
      </form>
    </div>
  )
}
