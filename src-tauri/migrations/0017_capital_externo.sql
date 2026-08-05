-- Fondo de capital externo para avances de efectivo: registra cada vez que
-- entra dinero de fuera de la caja para financiar avances (ej. alguien
-- deposita Bs 500 para eso). El saldo disponible se calcula restando lo ya
-- entregado en avances con fuente_efectivo = 'CAPITAL_EXTERIOR' — no vive
-- en esta tabla como un número guardado, para que nunca se desincronice.
CREATE TABLE IF NOT EXISTS aportes_capital_externo (
  id          TEXT PRIMARY KEY,
  monto_bs    REAL NOT NULL,
  nota        TEXT,
  usuario     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
