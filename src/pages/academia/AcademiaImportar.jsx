import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'

// academia.fwcinter.com/importar — traz os alunos do sistema antigo.
//
// A lista sai do banco do SCA (arquivo .json preparado pela FWC) e entra aqui
// de uma vez: nome, celular, matrícula, plano, valor e vencimento. Só falta o
// rosto, que cada aluno cadastra depois.
//
// A matrícula é a chave: importar de novo ATUALIZA quem já está lá (vencimento
// novo, por exemplo) em vez de duplicar.

const LOTE = 50

export default function AcademiaImportar() {
  const { empresa } = useAuth()
  const arquivoRef = useRef(null)
  const [alunos, setAlunos] = useState(null)
  const [erro, setErro] = useState(null)
  const [importando, setImportando] = useState(false)
  const [feitos, setFeitos] = useState(0)
  const [pronto, setPronto] = useState(null)

  function escolher(e) {
    const f = e.target.files?.[0]
    setErro(null); setPronto(null); setFeitos(0); setAlunos(null)
    if (!f) return
    const leitor = new FileReader()
    leitor.onload = () => {
      try {
        const lista = JSON.parse(leitor.result)
        if (!Array.isArray(lista) || !lista.length) throw new Error('vazio')
        if (!lista[0].nome) throw new Error('sem nome')
        setAlunos(lista)
      } catch {
        setErro('Esse arquivo não é a lista de alunos. Peça o arquivo certo (.json) pra FWC.')
      }
    }
    leitor.readAsText(f)
  }

  async function importar() {
    setImportando(true)
    setErro(null)
    let n = 0
    for (let i = 0; i < alunos.length; i += LOTE) {
      const linhas = alunos.slice(i, i + LOTE).map(a => ({
        empresa_id: empresa.id,
        matricula: String(a.matricula || '').trim() || null,
        nome: a.nome,
        telefone: a.telefone || null,
        plano: a.plano || null,
        valor: a.valor ?? null,
        vencimento: a.vencimento || null,
        ativo: true,
      }))
      const { error } = await supabase
        .from('academia_alunos')
        .upsert(linhas, { onConflict: 'empresa_id,matricula' })
      if (error) {
        setErro('Parou no aluno ' + (i + 1) + ': ' + error.message)
        setImportando(false)
        return
      }
      n += linhas.length
      setFeitos(n)
    }
    const { count } = await supabase
      .from('academia_alunos')
      .select('id', { count: 'exact', head: true })
      .eq('empresa_id', empresa.id)
    setImportando(false)
    setPronto({ importados: n, total: count ?? n })
  }

  const hoje = new Date().toISOString().slice(0, 10)
  const emDia = alunos?.filter(a => (a.vencimento || '') >= hoje).length
  const semTelefone = alunos?.filter(a => !a.telefone).length

  return (
    <div className="ac-card ac-form">
      <h2>Importar alunos do sistema antigo</h2>
      <p className="ac-muted">
        Escolha o arquivo da lista de alunos (.json) que a FWC preparou a partir do backup da academia.
        Quem já estiver cadastrado pela matrícula é <b>atualizado</b>, não duplicado. O rosto não vem
        no arquivo: cada aluno cadastra depois.
      </p>

      <input ref={arquivoRef} type="file" accept=".json,application/json" onChange={escolher} />

      {erro && <div className="ac-erro">{erro}</div>}

      {alunos && !pronto && (
        <>
          <div className="ac-aviso" style={{ color: 'var(--success)', background: 'var(--success-bg)' }}>
            <b>{alunos.length} alunos</b> no arquivo — {emDia} em dia e {alunos.length - emDia} vencidos.
            {semTelefone > 0 && <> {semTelefone} estão sem celular cadastrado.</>}
          </div>
          <div className="ac-lista">
            {alunos.slice(0, 5).map((a, i) => (
              <div key={i} className="ac-aluno" style={{ padding: '8px 12px' }}>
                <div className="ac-aluno-info">
                  <strong>{a.nome}</strong>
                  <span className="ac-muted">
                    matrícula {a.matricula} · {a.plano} · R$ {Number(a.valor || 0).toFixed(2).replace('.', ',')} ·
                    vence {a.vencimento?.split('-').reverse().join('/')}
                  </span>
                </div>
              </div>
            ))}
            {alunos.length > 5 && <p className="ac-muted">...e mais {alunos.length - 5}.</p>}
          </div>
          <div className="ac-form-botoes">
            <button className="btn btn-primary" onClick={importar} disabled={importando}>
              {importando ? `Importando... ${feitos} de ${alunos.length}` : `Importar ${alunos.length} alunos`}
            </button>
          </div>
        </>
      )}

      {pronto && (
        <div className="ac-aviso" style={{ color: 'var(--success)', background: 'var(--success-bg)' }}>
          Pronto: <b>{pronto.importados} alunos</b> importados. A academia tem {pronto.total} alunos cadastrados.
          Agora é cadastrar o rosto de cada um.
        </div>
      )}
    </div>
  )
}
