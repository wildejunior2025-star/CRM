-- Mapa "pela rua" da tela Raio de Entrega, igual ao do iFood (28/10/2026).
--
-- A area em volta da loja vira uma grade de quadradinhos, e cada um guarda os
-- km de moto ate a loja (Google Route Matrix). E calculada UMA vez por loja e
-- so refeita quando a loja muda de lugar ou aumenta o raio: ~1.500 pontos por
-- calculo, e a cota gratis da matriz e de 10 mil por mes.
--
-- celulas = [[lat, lng, km], ...]; quadradinho sem rua (rio, mangue) nao entra.
create table if not exists public.entrega_grade (
  empresa_id  uuid primary key references public.empresas(id) on delete cascade,
  origem_lat  double precision not null,
  origem_lng  double precision not null,
  raio_km     numeric not null,
  passo_m     integer not null,
  celulas     jsonb not null,
  created_at  timestamptz not null default now()
);

alter table public.entrega_grade enable row level security;

-- Quem e da loja le a grade dela; quem escreve e so a funcao (chave de servico).
drop policy if exists entrega_grade_le on public.entrega_grade;
create policy entrega_grade_le on public.entrega_grade for select to authenticated
  using (empresa_id = (select p.empresa_id from public.profiles p where p.id = (select auth.uid())));
