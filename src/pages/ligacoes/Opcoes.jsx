// Botões de escolha (uma só) da tela de ligação (mig 0292). Feito pra atendente
// marcar rápido, sem digitar.
export default function Opcoes({ valor, onChange, opcoes, grande }) {
  return (
    <div className={'lg-opcoes' + (grande ? ' lg-opcoes-grande' : '')}>
      {opcoes.map((o) => (
        <button
          type="button"
          key={String(o.v)}
          className={'lg-op' + (valor === o.v ? ' lg-op-on' : '')}
          onClick={() => onChange(o.v)}
        >
          {o.t}
        </button>
      ))}
    </div>
  )
}
