import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../hooks/useAuth'

// academia.fwcinter.com/equipe — quem trabalha na academia, cada um com o
// seu login.
//
// Até aqui a academia inteira entrava com UM login só: dono, recepção, quem
// estivesse no balcão. Isso tem dois problemas. Quem sai da equipe leva a
// senha de todo mundo, e nenhum relatório sabe quem fez o quê — não dá pra
// responder "quem cadastrou esse aluno?" nem "quem recebeu essa mensalidade?".
//
// Quem cria contas é a função create-vendor, a mesma do gestor das lojas: ela
// confere no servidor que quem pediu é admin e amarra a empresa — o site
// nunca toca na chave de administrador.

const URL_CRIAR = 'https://ycytrsqdvrviihkqfvno.supabase.co/functions/v1/create-vendor'

const VAZIO = { nome: '', email: '', senha: '', telefone: '' }

export default function AcademiaEquipe() {
  const { empresa, profile } = useAuth()
  const [gente, setGente] = useState([])
  const [carregando, setCarregando] = useState(true)
  const [form, setForm] = useState(VAZIO)
  const [criando, setCriando] = useState(false)
  const [erro, setErro] = useState(null)
  const [aviso, setAviso] = useState(null)

  const carregar = useCallback(async () => {
    setCarregando(true)
    const { data } = await supabase
      .from('profiles')
      .select('id, nome, email, telefone, perfil')
      .eq('empresa_id', empresa.id)
      .in('perfil', ['admin', 'super_admin', 'professor'])
      .order('nome')
    setGente(data || [])
    setCarregando(false)
  }, [empresa.id])

  useEffect(() => { carregar() }, [carregar])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function criar(e) {
    e.preventDefault()
    setErro(null)
    setAviso(null)
    if (!form.nome.trim()) return setErro('Coloque o nome da pessoa.')
    if (!form.email.trim()) return setErro('Coloque o e-mail que ela vai usar pra entrar.')
    if (form.senha.length < 6) return setErro('A senha precisa de pelo menos 6 letras ou números.')

    setCriando(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(URL_CRIAR, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          nome: form.nome.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.senha,
          telefone: form.telefone.trim() || undefined,
          perfil: 'admin',
        }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || 'Não deu pra criar.')
      setAviso(`Pronto. ${form.nome.trim()} entra com ${form.email.trim().toLowerCase()} e a senha que você escolheu.`)
      setForm(VAZIO)
      carregar()
    } catch (err) {
      setErro(err.message)
    } finally {
      setCriando(false)
    }
  }

  return (
    <div>
      <div className="ac-linha-titulo">
        <h2>Equipe</h2>
      </div>

      <p className="ac-aviso">
        Cada pessoa com o seu login. Quem sai da equipe perde só o acesso dela, e o
        sistema passa a saber quem cadastrou cada aluno e quem recebeu cada mensalidade.
        A senha do caixa continua valendo por cima disso.
      </p>

      {carregando ? <p className="ac-muted">Carregando...</p> : (
        <div className="ac-tabela-caixa">
          <table className="ac-tabela">
            <thead>
              <tr><th>Nome</th><th>Entra com</th><th>WhatsApp</th><th>Acesso</th></tr>
            </thead>
            <tbody>
              {gente.map(g => (
                <tr key={g.id}>
                  <td data-rotulo="Nome">
                    <strong>{g.nome || '—'}</strong>
                    {g.id === profile?.id && <span className="ac-status ac-liberado" style={{ marginLeft: 6 }}>você</span>}
                  </td>
                  <td data-rotulo="Entra com">{g.email}</td>
                  <td data-rotulo="WhatsApp">{g.telefone || '—'}</td>
                  <td data-rotulo="Acesso">{g.perfil === 'professor' ? 'Professor' : 'Academia'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="ac-card ac-form" onSubmit={criar} style={{ marginTop: 16 }}>
        <h3 style={{ margin: 0 }}>Adicionar alguém</h3>
        <div className="ac-form-campos">
          <label>Nome
            <input value={form.nome} onChange={e => set('nome', e.target.value)} placeholder="Nome de quem vai usar" />
          </label>
          <div className="ac-dupla">
            <label>E-mail pra entrar
              <input type="email" autoComplete="off" value={form.email}
                onChange={e => set('email', e.target.value)} placeholder="nome@gmail.com" />
            </label>
            <label>WhatsApp
              <input inputMode="tel" value={form.telefone}
                onChange={e => set('telefone', e.target.value)} placeholder="(84) 99999-9999" />
            </label>
          </div>
          <label>Senha
            <input type="text" autoComplete="off" value={form.senha}
              onChange={e => set('senha', e.target.value)} placeholder="mínimo 6 caracteres" />
          </label>
          <p className="ac-muted">
            Escolha uma senha e passe pra pessoa. Ela pode ser qualquer e-mail que a
            pessoa tenha — serve só pra identificar quem é.
          </p>
        </div>

        {erro && <div className="ac-erro">{erro}</div>}
        {aviso && <div className="ac-aviso">{aviso}</div>}

        <div className="ac-form-botoes">
          <button className="btn btn-primary" disabled={criando}>
            {criando ? 'Criando...' : 'Criar login'}
          </button>
        </div>
      </form>
    </div>
  )
}
