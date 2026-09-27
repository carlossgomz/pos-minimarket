import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getDb } from "../db";
import { ConfigRow } from "../types";
import logoDefecto from "../assets/logo.png";

// Tamaño máximo del logo guardado en la base — mismo límite que las otras
// 3 ediciones (ver Configuracion.tsx de pos-avanzado).
const LOGO_MAX_BYTES = 400 * 1024;

type Categoria = "negocio" | "acerca";

const CATEGORIAS: { key: Categoria; label: string }[] = [
  { key: "negocio", label: "Negocio" },
  { key: "acerca", label: "Acerca de" },
];

// Mismo modal ⚙ que las otras 3 ediciones (Configuracion.tsx de
// pos-avanzado) — Día Express no tiene Usuarios/Personalización/Métodos de
// pago propios (Usuarios ya es su propia pestaña, Tema ya es un botón en
// el encabezado), así que solo lleva Negocio (nombre, logo, RIF,
// dirección, teléfono — antes solo editables desde Kaxa Móvil) y Acerca de.
export default function Configuracion({
  config,
  esAdmin,
  onCerrar,
  onConfigActualizado,
}: {
  config: ConfigRow;
  esAdmin: boolean;
  onCerrar: () => void;
  onConfigActualizado: () => Promise<void> | void;
}) {
  const [categoria, setCategoria] = useState<Categoria>(esAdmin ? "negocio" : "acerca");
  const [nombre, setNombre] = useState(config.nombre_negocio);
  const [rif, setRif] = useState(config.rif_negocio ?? "");
  const [direccion, setDireccion] = useState(config.direccion_negocio ?? "");
  const [telefono, setTelefono] = useState(config.telefono_negocio ?? "");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [esError, setEsError] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  async function guardarCampo(campo: string, valor: string, etiqueta: string) {
    setMensaje(null);
    setGuardando(true);
    try {
      const db = await getDb();
      await db.execute(`UPDATE config SET ${campo} = $1 WHERE id = 1`, [valor.trim() || null]);
      await onConfigActualizado();
      setEsError(false);
      setMensaje(`${etiqueta} guardado`);
    } catch (e) {
      setEsError(true);
      setMensaje(`No se pudo guardar: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  async function guardarNombre() {
    if (!nombre.trim()) return;
    setMensaje(null);
    setGuardando(true);
    try {
      const db = await getDb();
      await db.execute("UPDATE config SET nombre_negocio = $1 WHERE id = 1", [nombre.trim()]);
      await onConfigActualizado();
      setEsError(false);
      setMensaje("Nombre guardado");
    } catch (e) {
      setEsError(true);
      setMensaje(`No se pudo guardar: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  async function cambiarLogo(archivo: File) {
    if (!archivo.type.startsWith("image/")) {
      setEsError(true);
      setMensaje("Elige un archivo de imagen (PNG o JPG).");
      return;
    }
    if (archivo.size > LOGO_MAX_BYTES) {
      setEsError(true);
      setMensaje(`La imagen pesa demasiado (máx. ${Math.round(LOGO_MAX_BYTES / 1024)} KB) — usa una más liviana.`);
      return;
    }
    const dataUri = await new Promise<string>((resolve, reject) => {
      const lector = new FileReader();
      lector.onload = () => resolve(String(lector.result));
      lector.onerror = () => reject(lector.error);
      lector.readAsDataURL(archivo);
    });
    setMensaje(null);
    setGuardando(true);
    try {
      const db = await getDb();
      await db.execute("UPDATE config SET logo_base64 = $1 WHERE id = 1", [dataUri]);
      await onConfigActualizado();
      setEsError(false);
      setMensaje("Logo actualizado");
    } catch (e) {
      setEsError(true);
      setMensaje(`No se pudo guardar el logo: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  async function quitarLogo() {
    setMensaje(null);
    setGuardando(true);
    try {
      const db = await getDb();
      await db.execute("UPDATE config SET logo_base64 = NULL WHERE id = 1", []);
      await onConfigActualizado();
      setEsError(false);
      setMensaje("Se restauró el logo por defecto");
    } catch (e) {
      setEsError(true);
      setMensaje(`No se pudo quitar el logo: ${String(e)}`);
    } finally {
      setGuardando(false);
    }
  }

  const categorias = esAdmin ? CATEGORIAS : CATEGORIAS.filter((c) => c.key === "acerca");

  return (
    <div className="modal-fondo" onMouseDown={onCerrar}>
      <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()} style={{ padding: 0, overflow: "hidden" }}>
        <div
          className="form-row"
          style={{
            justifyContent: "space-between",
            alignItems: "center",
            margin: 0,
            padding: "14px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ margin: 0 }}>⚙ Configuración</h2>
          <button type="button" className="link-btn" onClick={onCerrar}>
            cerrar
          </button>
        </div>

        <div style={{ display: "flex", minHeight: 300 }}>
          {categorias.length > 1 && (
            <div style={{ width: 170, flexShrink: 0, borderRight: "1px solid var(--border)", padding: 10 }}>
              {categorias.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => {
                    setCategoria(c.key);
                    setMensaje(null);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "9px 12px",
                    marginBottom: 4,
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontWeight: 500,
                    fontSize: 14,
                    background: categoria === c.key ? "var(--accent)" : "transparent",
                    color: categoria === c.key ? "var(--accent-contrast)" : "var(--text-secondary)",
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <div style={{ flex: 1, padding: 20, overflowY: "auto" }}>
            {mensaje && <p className={esError ? "error" : "hint"}>{mensaje}</p>}

            {categoria === "negocio" && esAdmin && (
              <>
                <h3 style={{ margin: "0 0 14px" }}>Negocio</h3>

                <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginBottom: 16 }}>
                  <label>Nombre de la tienda</label>
                  <div className="form-row">
                    <input value={nombre} onChange={(e) => setNombre(e.target.value)} style={{ flex: 1 }} />
                    <button type="button" onClick={guardarNombre} disabled={guardando || !nombre.trim()}>
                      Guardar
                    </button>
                  </div>
                </div>

                <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginBottom: 16 }}>
                  <label>Logo</label>
                  <div className="form-row" style={{ alignItems: "center", gap: 12 }}>
                    <img
                      src={config.logo_base64 ?? logoDefecto}
                      alt="Logo actual"
                      style={{ height: 48, width: "auto", background: "#fff", borderRadius: 6, padding: 4 }}
                    />
                    <input
                      type="file"
                      accept="image/*"
                      disabled={guardando}
                      onChange={(e) => {
                        const archivo = e.target.files?.[0];
                        if (archivo) cambiarLogo(archivo);
                        e.target.value = "";
                      }}
                    />
                    {config.logo_base64 && (
                      <button type="button" className="link-btn" onClick={quitarLogo} disabled={guardando}>
                        quitar
                      </button>
                    )}
                  </div>
                  <p className="hint" style={{ margin: 0 }}>
                    Se usa en el encabezado y en los tickets impresos. Máximo {Math.round(LOGO_MAX_BYTES / 1024)} KB.
                  </p>
                </div>

                <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginBottom: 16 }}>
                  <label>RIF</label>
                  <div className="form-row">
                    <input value={rif} onChange={(e) => setRif(e.target.value)} placeholder="J-12345678-9" style={{ flex: 1 }} />
                    <button type="button" onClick={() => guardarCampo("rif_negocio", rif, "RIF")} disabled={guardando}>
                      Guardar
                    </button>
                  </div>
                </div>

                <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6, marginBottom: 16 }}>
                  <label>Dirección</label>
                  <div className="form-row">
                    <input value={direccion} onChange={(e) => setDireccion(e.target.value)} style={{ flex: 1 }} />
                    <button type="button" onClick={() => guardarCampo("direccion_negocio", direccion, "Dirección")} disabled={guardando}>
                      Guardar
                    </button>
                  </div>
                </div>

                <div className="form-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                  <label>Teléfono</label>
                  <div className="form-row">
                    <input value={telefono} onChange={(e) => setTelefono(e.target.value)} style={{ flex: 1 }} />
                    <button type="button" onClick={() => guardarCampo("telefono_negocio", telefono, "Teléfono")} disabled={guardando}>
                      Guardar
                    </button>
                  </div>
                </div>
              </>
            )}

            {categoria === "acerca" && (
              <>
                <h3 style={{ margin: "0 0 14px" }}>Acerca de</h3>
                <p style={{ margin: 0, fontSize: 15 }}>
                  Kaxa {version ? `v${version}` : "…"}
                  <br />
                  Edición: Día Express
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
