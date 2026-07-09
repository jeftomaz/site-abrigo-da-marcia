-- ============================================================
-- ABRIGO DA MÁRCIA — Schema de Eventos de Arrecadação (Fase 6)
-- Execute este arquivo no SQL Editor do Supabase:
-- Dashboard → SQL Editor → New query → Cole e execute
--
-- Pré-requisito: schema.sql já executado (reutiliza a função
-- update_updated_at — recriada abaixo por segurança).
-- Bloco idempotente: seguro rodar mais de uma vez.
--
-- Modelo de segurança:
--   • reservations/reservation_items NUNCA são legíveis pelo
--     público (contêm nome e contato dos clientes).
--   • A única escrita pública é via RPC create_reservation,
--     que valida tudo e aplica o anti-abuso.
--   • A grade da rifa e os totais são expostos por views que
--     só revelam dados não pessoais (número + primeiro nome).
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. TABELA: events
-- Um evento por linha; apenas um 'ativo' por vez.
-- Campos raffle_* usados somente quando type = 'rifa'.
-- Campos pix_*: ou o admin informa chave + nome + cidade (o
-- site monta o BR Code), ou cola um copia-e-cola pronto
-- gerado no PagSeguro em pix_payload.
-- ──────────────────────────────────────────────────────────

create table if not exists events (
  id                   uuid        primary key default gen_random_uuid(),
  type                 text        not null check (type in ('rifa', 'venda')),
  name                 text        not null,
  description          text,
  cover_url            text,
  gallery              text[]      not null default '{}',  -- imagens de divulgação
  starts_at            date        not null,
  ends_at              date        not null,
  status               text        not null default 'rascunho'
                       check (status in ('rascunho', 'ativo', 'encerrado', 'arquivado')),
  goal_amount          numeric(10,2) check (goal_amount is null or goal_amount > 0),
  pix_key              text,
  pix_merchant_name    text,       -- nome do recebedor (exigido pelo BR Code)
  pix_merchant_city    text,       -- cidade do recebedor (exigido pelo BR Code)
  pix_payload          text,       -- copia-e-cola pronto (opcional, ex: PagSeguro)
  payment_instructions text,
  raffle_total_numbers integer     check (raffle_total_numbers is null or raffle_total_numbers between 1 and 10000),
  raffle_number_price  numeric(10,2) check (raffle_number_price is null or raffle_number_price > 0),
  raffle_max_per_reservation integer not null default 5
                       check (raffle_max_per_reservation between 1 and 50),  -- nºs por reserva
  raffle_prize         text,
  raffle_prizes        jsonb       not null default '[]'
                       check (
                         jsonb_typeof(raffle_prizes) = 'array'
                         and case when jsonb_typeof(raffle_prizes) = 'array'
                           then jsonb_array_length(raffle_prizes) <= 3
                           else false
                         end
                       ),
  raffle_winner_number integer     check (raffle_winner_number is null or raffle_winner_number >= 1),
  -- marca quando um evento arquivado foi reaberto para correção (histórico):
  -- enquanto arquivado as reservas são somente-leitura no admin; reabrir
  -- (arquivado → encerrado) descongela e grava esta data
  reopened_at          timestamptz,
  -- preenchido por purge_event_data() ANTES de deletar as reservas,
  -- para o histórico público continuar completo sem dados pessoais
  summary              jsonb,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  constraint events_periodo check (ends_at >= starts_at),
  constraint events_rifa_campos check (
    type <> 'rifa' or (raffle_total_numbers is not null and raffle_number_price is not null)
  ),
  constraint events_gallery_max check (coalesce(array_length(gallery, 1), 0) <= 5)
);

-- Garante um único evento ativo por vez
create unique index if not exists events_um_ativo
  on events ((status)) where status = 'ativo';

-- Auto-atualiza updated_at (mesma função do schema.sql)
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_updated_at on events;
create trigger events_updated_at
  before update on events
  for each row execute function update_updated_at();

-- Migração: limite de números por reserva na rifa (instalações anteriores
-- a 2026-06-13). Seguro rodar mais de uma vez.
alter table events add column if not exists raffle_max_per_reservation integer not null default 5;
alter table events drop constraint if exists events_raffle_max_check;
alter table events add constraint events_raffle_max_check
  check (raffle_max_per_reservation between 1 and 50);

-- Migração: até 3 prêmios por rifa, cada um com nome, imagem e número
-- vencedor próprio. Os campos antigos seguem existindo como fallback para
-- instalações em transição.
alter table events add column if not exists raffle_prizes jsonb not null default '[]';
update events
   set raffle_prizes = jsonb_build_array(jsonb_build_object(
       'name', coalesce(raffle_prize, 'Prêmio'),
       'image_url', '',
       'winner_number', raffle_winner_number
   ))
 where type = 'rifa'
   and raffle_prizes = '[]'::jsonb
   and (raffle_prize is not null or raffle_winner_number is not null);
alter table events drop constraint if exists events_raffle_prizes_arr;
alter table events add constraint events_raffle_prizes_arr
  check (
    jsonb_typeof(raffle_prizes) = 'array'
    and case when jsonb_typeof(raffle_prizes) = 'array'
      then jsonb_array_length(raffle_prizes) <= 3
      else false
    end
  );

-- Migração: registro de reabertura de evento arquivado (instalações anteriores
-- a 2026-06-13). Seguro rodar mais de uma vez.
alter table events add column if not exists reopened_at timestamptz;

-- ──────────────────────────────────────────────────────────
-- 2. TABELA: event_products (produtos de eventos de venda)
-- attributes: lista de atributos definida pelo admin, livre
-- por produto. Ex:
--   [{"name": "Gênero",  "options": ["Masculina", "Feminina"]},
--    {"name": "Tamanho", "options": ["P", "M", "G", "GG", "XG"]}]
-- ──────────────────────────────────────────────────────────

create table if not exists event_products (
  id         uuid          primary key default gen_random_uuid(),
  event_id   uuid          not null references events(id) on delete cascade,
  name       text          not null,
  price      numeric(10,2) not null check (price > 0),
  -- até 3 imagens (URLs); a 1ª é a capa exibida na vitrine
  images     jsonb         not null default '[]' check (jsonb_typeof(images) = 'array'),
  attributes jsonb         not null default '[]' check (jsonb_typeof(attributes) = 'array'),
  -- tabela de medidas (opcional): imagem OU manual, nunca os dois.
  -- size_chart manual = [{"label":"Altura","value":"30 cm"}, ...]
  size_chart_image text,
  size_chart       jsonb   check (size_chart is null or jsonb_typeof(size_chart) = 'array'),
  sort_order integer       not null default 0,
  created_at timestamptz   default now(),
  constraint event_products_sizechart_one check (size_chart_image is null or size_chart is null)
);

create index if not exists event_products_event on event_products (event_id);

-- ──────────────────────────────────────────────────────────
-- MIGRAÇÃO — produtos: imagem única → até 3 imagens + medidas
-- Idempotente (pode rodar mais de uma vez). Aplica-se a bancos
-- que já tinham event_products com a coluna `image`.
-- ──────────────────────────────────────────────────────────
alter table event_products add column if not exists images           jsonb not null default '[]';
alter table event_products add column if not exists size_chart_image text;
alter table event_products add column if not exists size_chart       jsonb;

do $$
begin
  -- move a imagem única antiga para o array `images` e descarta a coluna
  if exists (select 1 from information_schema.columns
             where table_name = 'event_products' and column_name = 'image') then
    update event_products
       set images = jsonb_build_array(image)
     where image is not null and images = '[]'::jsonb;
    alter table event_products drop column image;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'event_products_images_arr') then
    alter table event_products add constraint event_products_images_arr
      check (jsonb_typeof(images) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_products_sizechart_arr') then
    alter table event_products add constraint event_products_sizechart_arr
      check (size_chart is null or jsonb_typeof(size_chart) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'event_products_sizechart_one') then
    alter table event_products add constraint event_products_sizechart_one
      check (size_chart_image is null or size_chart is null);
  end if;
end $$;

-- ──────────────────────────────────────────────────────────
-- 3. TABELA: reservations (dados pessoais — acesso restrito)
-- ──────────────────────────────────────────────────────────

create table if not exists reservations (
  id            uuid        primary key default gen_random_uuid(),
  event_id      uuid        not null references events(id) on delete cascade,
  customer_name text        not null check (char_length(customer_name) between 2 and 100),
  contact       text        not null check (char_length(contact) between 8 and 100),
  status        text        not null default 'reservado'
                check (status in ('reservado', 'pago', 'entregue', 'cancelado')),
  notes         text,       -- anotações do admin
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

create index if not exists reservations_event_status on reservations (event_id, status);
-- consulta do anti-abuso (reservas recentes do mesmo contato)
create index if not exists reservations_event_contato on reservations (event_id, lower(contact), created_at);

drop trigger if exists reservations_updated_at on reservations;
create trigger reservations_updated_at
  before update on reservations
  for each row execute function update_updated_at();

-- ──────────────────────────────────────────────────────────
-- 4. TABELA: reservation_items
-- Rifa:  raffle_number preenchido, product_id nulo.
-- Venda: product_id + variation + quantity, raffle_number nulo.
-- event_id desnormalizado para o índice único da rifa.
-- released: vira true quando a reserva é cancelada, liberando
-- o número da rifa sem perder o histórico do que foi reservado.
-- unit_price: preço congelado no momento da reserva (o admin
-- pode alterar o preço do produto depois sem afetar pedidos).
-- ──────────────────────────────────────────────────────────

create table if not exists reservation_items (
  id             uuid          primary key default gen_random_uuid(),
  reservation_id uuid          not null references reservations(id) on delete cascade,
  event_id       uuid          not null references events(id) on delete cascade,
  raffle_number  integer       check (raffle_number is null or raffle_number >= 1),
  released       boolean       not null default false,
  product_id     uuid          references event_products(id) on delete restrict,
  variation      jsonb         check (variation is null or jsonb_typeof(variation) = 'object'),
  quantity       integer       not null default 1 check (quantity between 1 and 100),
  unit_price     numeric(10,2) not null check (unit_price >= 0),
  constraint item_um_tipo check (
    (raffle_number is not null and product_id is null)
    or
    (raffle_number is null and product_id is not null)
  )
);

create index if not exists reservation_items_reservation on reservation_items (reservation_id);
create index if not exists reservation_items_event on reservation_items (event_id);

-- O CORAÇÃO DA RIFA: o banco rejeita duas reservas ativas do
-- mesmo número, mesmo com cliques simultâneos. Reservas
-- canceladas (released = true) saem do índice e liberam o número.
create unique index if not exists raffle_numero_unico
  on reservation_items (event_id, raffle_number)
  where raffle_number is not null and released = false;

-- Cancelar reserva libera o número; reativar tenta retomá-lo
-- (se outro cliente já pegou, o índice único bloqueia e o admin
-- vê o erro — comportamento desejado).
create or replace function sync_raffle_release()
returns trigger language plpgsql as $$
begin
  if new.status = 'cancelado' and old.status <> 'cancelado' then
    update reservation_items set released = true  where reservation_id = new.id;
  elsif new.status <> 'cancelado' and old.status = 'cancelado' then
    update reservation_items set released = false where reservation_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_raffle_release on reservations;
create trigger reservations_raffle_release
  after update of status on reservations
  for each row execute function sync_raffle_release();

-- ──────────────────────────────────────────────────────────
-- 5. RLS (Row Level Security)
-- ──────────────────────────────────────────────────────────

alter table events            enable row level security;
alter table event_products    enable row level security;
alter table reservations      enable row level security;
alter table reservation_items enable row level security;

-- events: público lê apenas eventos publicados (nunca rascunhos)
drop policy if exists "Público lê eventos publicados" on events;
create policy "Público lê eventos publicados"
  on events for select
  to anon
  using (status in ('ativo', 'encerrado', 'arquivado'));

drop policy if exists "Admin gerencia eventos" on events;
create policy "Admin gerencia eventos"
  on events for all
  to authenticated
  using (true)
  with check (true);

-- event_products: público lê produtos de eventos publicados
drop policy if exists "Público lê produtos publicados" on event_products;
create policy "Público lê produtos publicados"
  on event_products for select
  to anon
  using (exists (
    select 1 from events e
    where e.id = event_id and e.status in ('ativo', 'encerrado', 'arquivado')
  ));

drop policy if exists "Admin gerencia produtos" on event_products;
create policy "Admin gerencia produtos"
  on event_products for all
  to authenticated
  using (true)
  with check (true);

-- reservations / reservation_items: NENHUM acesso anônimo.
-- Sem política para anon = bloqueado. Escrita pública só pela
-- RPC create_reservation (security definer, seção 7).
drop policy if exists "Admin gerencia reservas" on reservations;
create policy "Admin gerencia reservas"
  on reservations for all
  to authenticated
  using (true)
  with check (true);

drop policy if exists "Admin gerencia itens de reserva" on reservation_items;
create policy "Admin gerencia itens de reserva"
  on reservation_items for all
  to authenticated
  using (true)
  with check (true);

-- ──────────────────────────────────────────────────────────
-- 6. VIEWS PÚBLICAS (security definer — INTENCIONAL)
-- Elas existem justamente para contornar o RLS das tabelas de
-- reservas expondo SOMENTE dados não pessoais. O linter do
-- Supabase avisa sobre security definer views; aqui é proposital.
-- ──────────────────────────────────────────────────────────

-- Grade da rifa: apenas QUAIS números estão tomados. NUNCA expõe dados
-- pessoais — páginas públicas não mostram nomes (nem o do ganhador). O
-- nome do ganhador aparece só na tela de sorteio do admin, durante a
-- transmissão ao vivo. Número ausente na view = número livre.
-- (drop + create porque a versão anterior tinha a coluna first_name)
drop view if exists raffle_board;
create view raffle_board
with (security_invoker = off) as
  select
    ri.event_id,
    ri.raffle_number
  from reservation_items ri
  join reservations r on r.id = ri.reservation_id
  join events e       on e.id = ri.event_id
  where ri.raffle_number is not null
    and ri.released = false
    and r.status <> 'cancelado'
    and e.status in ('ativo', 'encerrado', 'arquivado');

grant select on raffle_board to anon, authenticated;

-- Totais agregados por evento (barra de meta, painel do admin)
create or replace view event_totals
with (security_invoker = off) as
  select
    e.id as event_id,
    count(distinct r.id) filter (where r.status <> 'cancelado')                              as reservation_count,
    coalesce(sum(ri.quantity)                 filter (where r.status <> 'cancelado'), 0)     as items_sold,
    coalesce(sum(ri.quantity * ri.unit_price) filter (where r.status <> 'cancelado'), 0)     as amount_reserved,
    coalesce(sum(ri.quantity * ri.unit_price) filter (where r.status in ('pago', 'entregue')), 0) as amount_paid
  from events e
  left join reservations r       on r.event_id = e.id
  left join reservation_items ri on ri.reservation_id = r.id
  where e.status in ('ativo', 'encerrado', 'arquivado')
  group by e.id;

grant select on event_totals to anon, authenticated;

-- ──────────────────────────────────────────────────────────
-- 7. RPC: create_reservation
-- Único ponto de escrita pública. Em uma transação: valida o
-- evento, aplica anti-abuso, valida itens e grava tudo —
-- qualquer falha desfaz a reserva inteira.
--
-- Códigos de erro (mapeados para mensagens amigáveis no JS):
--   RESERVA_INVALIDA, NOME_INVALIDO, CONTATO_INVALIDO,
--   ITENS_INVALIDOS, EVENTO_INDISPONIVEL, LIMITE_RESERVAS_HORA,
--   LIMITE_RESERVAS_EVENTO, RIFA_LIMITE_NUMEROS, NUMERO_INVALIDO,
--   NUMERO_INDISPONIVEL, ITEM_INVALIDO, PRODUTO_INVALIDO,
--   QUANTIDADE_INVALIDA, VARIACAO_INVALIDA
--
-- p_website é o honeypot: campo invisível no formulário que
-- humanos deixam vazio e bots preenchem.
-- ──────────────────────────────────────────────────────────

create or replace function create_reservation(
  p_event_id uuid,
  p_name     text,
  p_contact  text,
  p_items    jsonb,
  p_website  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event          events%rowtype;
  v_item           jsonb;
  v_count          integer;
  v_reservation_id uuid;
  v_number         integer;
  v_product        event_products%rowtype;
  v_product_id     uuid;
  v_variation      jsonb;
  v_qty            integer;
  v_attr           jsonb;
  v_value          text;
  v_total          numeric := 0;
begin
  -- Honeypot: humanos não veem o campo, bots preenchem
  if p_website is not null and length(trim(p_website)) > 0 then
    raise exception 'RESERVA_INVALIDA';
  end if;

  p_name    := trim(coalesce(p_name, ''));
  p_contact := trim(coalesce(p_contact, ''));

  if char_length(p_name) < 2 or char_length(p_name) > 100 then
    raise exception 'NOME_INVALIDO';
  end if;
  if char_length(p_contact) < 8 or char_length(p_contact) > 100 then
    raise exception 'CONTATO_INVALIDO';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 20 then
    raise exception 'ITENS_INVALIDOS';
  end if;

  -- Evento precisa estar ativo e dentro do período
  select * into v_event from events where id = p_event_id;
  if not found or v_event.status <> 'ativo'
     or current_date < v_event.starts_at or current_date > v_event.ends_at then
    raise exception 'EVENTO_INDISPONIVEL';
  end if;

  -- Anti-abuso: máx. 3 reservas/hora e 10 ativas por evento, por contato
  select count(*) into v_count from reservations
    where event_id = p_event_id
      and lower(contact) = lower(p_contact)
      and created_at > now() - interval '1 hour';
  if v_count >= 3 then
    raise exception 'LIMITE_RESERVAS_HORA';
  end if;

  select count(*) into v_count from reservations
    where event_id = p_event_id
      and lower(contact) = lower(p_contact)
      and status <> 'cancelado';
  if v_count >= 10 then
    raise exception 'LIMITE_RESERVAS_EVENTO';
  end if;

  -- Rifa: o cliente pode reservar vários números numa só reserva,
  -- respeitando o limite configurado pelo admin no evento.
  if v_event.type = 'rifa'
     and jsonb_array_length(p_items) > coalesce(v_event.raffle_max_per_reservation, 5) then
    raise exception 'RIFA_LIMITE_NUMEROS';
  end if;

  insert into reservations (event_id, customer_name, contact)
    values (p_event_id, p_name, p_contact)
    returning id into v_reservation_id;

  for v_item in select value from jsonb_array_elements(p_items) loop

    if v_event.type = 'rifa' then
      begin
        v_number := (v_item->>'raffle_number')::integer;
      exception when others then
        raise exception 'NUMERO_INVALIDO';
      end;
      if v_number is null or v_number < 1 or v_number > v_event.raffle_total_numbers then
        raise exception 'NUMERO_INVALIDO';
      end if;

      begin
        insert into reservation_items (reservation_id, event_id, raffle_number, quantity, unit_price)
          values (v_reservation_id, p_event_id, v_number, 1, v_event.raffle_number_price);
      exception when unique_violation then
        -- outro cliente reservou este número primeiro
        raise exception 'NUMERO_INDISPONIVEL';
      end;
      v_total := v_total + v_event.raffle_number_price;

    else -- venda
      begin
        v_product_id := (v_item->>'product_id')::uuid;
        v_qty        := coalesce((v_item->>'quantity')::integer, 0);
      exception when others then
        raise exception 'ITEM_INVALIDO';
      end;

      select * into v_product from event_products
        where id = v_product_id and event_id = p_event_id;
      if not found then
        raise exception 'PRODUTO_INVALIDO';
      end if;
      if v_qty < 1 or v_qty > 100 then
        raise exception 'QUANTIDADE_INVALIDA';
      end if;

      -- A variação deve ter EXATAMENTE os atributos definidos no
      -- produto, com valores dentro das opções (camiseta exige
      -- Gênero + Tamanho; caneca só Cor; pizza nenhum)
      v_variation := coalesce(v_item->'variation', '{}'::jsonb);
      if jsonb_typeof(v_variation) <> 'object' then
        raise exception 'VARIACAO_INVALIDA';
      end if;
      if (select count(*) from jsonb_object_keys(v_variation)) <> jsonb_array_length(v_product.attributes) then
        raise exception 'VARIACAO_INVALIDA';
      end if;
      for v_attr in select value from jsonb_array_elements(v_product.attributes) loop
        v_value := v_variation->>(v_attr->>'name');
        if v_value is null or not (v_attr->'options' ? v_value) then
          raise exception 'VARIACAO_INVALIDA';
        end if;
      end loop;

      -- Preço sempre o do banco, nunca o enviado pelo cliente
      insert into reservation_items (reservation_id, event_id, product_id, variation, quantity, unit_price)
        values (v_reservation_id, p_event_id, v_product.id, v_variation, v_qty, v_product.price);
      v_total := v_total + (v_qty * v_product.price);
    end if;

  end loop;

  return jsonb_build_object(
    'reservation_id', v_reservation_id,
    'total', v_total
  );
end;
$$;

-- Pública por design: é o canal de reserva dos visitantes
grant execute on function create_reservation(uuid, text, text, jsonb, text) to anon, authenticated;

-- ──────────────────────────────────────────────────────────
-- 8. RPC: purge_event_data (limpeza LGPD — fase 6.6)
-- Chamada pelo admin APÓS baixar o CSV de backup. Na mesma
-- transação: grava os agregados não pessoais em events.summary
-- e DELETA as reservas do evento (itens caem em cascata).
-- ──────────────────────────────────────────────────────────

create or replace function purge_event_data(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_summary jsonb;
begin
  if auth.uid() is null then
    raise exception 'NAO_AUTORIZADO';
  end if;

  select jsonb_build_object(
    'purged_at',    now(),
    'reservations', count(distinct r.id) filter (where r.status <> 'cancelado'),
    'items_sold',   coalesce(sum(ri.quantity) filter (where r.status <> 'cancelado'), 0),
    'total_raised', coalesce(sum(ri.quantity * ri.unit_price) filter (where r.status in ('pago', 'entregue')), 0)
  ) into v_summary
  from reservations r
  left join reservation_items ri on ri.reservation_id = r.id
  where r.event_id = p_event_id;

  update events set summary = v_summary where id = p_event_id;
  delete from reservations where event_id = p_event_id;

  return v_summary;
end;
$$;

-- Apenas o admin autenticado pode executar
revoke execute on function purge_event_data(uuid) from public, anon;
grant execute on function purge_event_data(uuid) to authenticated;

-- ──────────────────────────────────────────────────────────
-- 9. STORAGE: bucket event-photos
-- Mesmo padrão do dog-photos (leitura pública, escrita admin).
-- ──────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('event-photos', 'event-photos', true)
on conflict (id) do nothing;

drop policy if exists "Público lê fotos de eventos" on storage.objects;
create policy "Público lê fotos de eventos"
  on storage.objects for select
  to anon
  using (bucket_id = 'event-photos');

drop policy if exists "Admin gerencia fotos de eventos" on storage.objects;
create policy "Admin gerencia fotos de eventos"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'event-photos')
  with check (bucket_id = 'event-photos');

-- ──────────────────────────────────────────────────────────
-- 10. TESTE RÁPIDO (opcional — descomente para experimentar)
-- Cria uma rifa de teste e simula uma reserva pela RPC.
-- ──────────────────────────────────────────────────────────

-- insert into events (type, name, description, starts_at, ends_at, status,
--                     pix_key, pix_merchant_name, pix_merchant_city,
--                     raffle_total_numbers, raffle_number_price, raffle_prize, raffle_prizes)
-- values ('rifa', 'Rifa de Teste', 'Apenas para testes — apague depois.',
--         current_date, current_date + 30, 'ativo',
--         'chave@pix.com', 'Abrigo da Marcia', 'Ribeirao Preto',
--         100, 10.00, 'Cesta de prêmios',
--         '[{"name":"Cesta de prêmios","image_url":"","winner_number":null}]'::jsonb);

-- select create_reservation(
--   (select id from events where name = 'Rifa de Teste'),
--   'Maria Silva',
--   '(16) 99999-0000',
--   '[{"raffle_number": 42}]'::jsonb
-- );

-- select * from raffle_board;   -- deve mostrar o nº 42 — Maria
-- select * from event_totals;   -- deve mostrar 1 reserva, R$ 10 reservados

-- Repetir o nº 42 deve falhar com NUMERO_INDISPONIVEL:
-- select create_reservation(
--   (select id from events where name = 'Rifa de Teste'),
--   'João Souza', 'joao@email.com', '[{"raffle_number": 42}]'::jsonb
-- );

-- Limpeza do teste:
-- delete from events where name = 'Rifa de Teste';
