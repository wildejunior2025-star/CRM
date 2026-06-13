alter table whatsapp_config
  add column if not exists admin_phone text not null default '',
  add column if not exists notif_estoque boolean not null default false;
