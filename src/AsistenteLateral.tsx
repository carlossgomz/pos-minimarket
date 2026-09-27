import { useEffect, useState } from "react";
import KaxMascota, { PoseKax } from "./KaxMascota";
import { Consejo, DestinoConsejo, obtenerConsejosGenerales } from "./asistente";

// Cada 5 minutos alcanza de sobra — son consejos, no algo que necesite
// sentirse en tiempo real, y así se evita sumarle presión al límite de
// consultas de Turso (ver memoria del proyecto sobre eso).
const REFRESCO_MS = 5 * 60 * 1000;
const MINIMIZADO_KEY = "kax-asistente-minimizado";
// Por PC (localStorage, no por usuario) — la mascota es nueva para
// cualquiera que abra Kaxa después de esta actualización, sea cajero o
// admin, así que se presenta una sola vez en cada equipo.
const INTRO_VISTA_KEY = "kax-intro-vista";

function poseDeConsejo(consejo: Consejo | undefined): PoseKax {
  if (!consejo) return "neutral";
  if (consejo.prioridad === "positivo") return "celebrando";
  if (consejo.prioridad === "urgente" || consejo.prioridad === "atencion") return "alerta";
  return "neutral";
}

// Mascota Kax fija del lado izquierdo del programa — acompaña en
// cualquier pestaña, mostrando los mismos consejos accionables que ya
// existían en Estadísticas/Reportes pero sin tener que entrar ahí, y con
// clic para ir directo a la pantalla que resuelve cada aviso (ej. "fulano
// debe hace muchos días" -> Cuentas).
export default function AsistenteLateral({
  esAdmin,
  tasa,
  onNavegar,
}: {
  esAdmin: boolean;
  tasa: number;
  onNavegar: (destino: DestinoConsejo) => void;
}) {
  const [consejos, setConsejos] = useState<Consejo[]>([]);
  const [indice, setIndice] = useState(0);
  const [minimizado, setMinimizado] = useState(() => localStorage.getItem(MINIMIZADO_KEY) === "1");
  const [mostrarIntro, setMostrarIntro] = useState(() => localStorage.getItem(INTRO_VISTA_KEY) !== "1");

  function cerrarIntro() {
    localStorage.setItem(INTRO_VISTA_KEY, "1");
    setMostrarIntro(false);
  }

  async function cargar() {
    try {
      const lista = await obtenerConsejosGenerales(esAdmin, tasa);
      setConsejos(lista);
      setIndice(0);
    } catch {
      // si falla (ej. sin conexión), Kax simplemente no tiene nada nuevo
      // que decir por ahora — no vale la pena interrumpir con un error acá
    }
  }

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, REFRESCO_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esAdmin]);

  function minimizar() {
    setMinimizado(true);
    localStorage.setItem(MINIMIZADO_KEY, "1");
  }
  function expandir() {
    setMinimizado(false);
    localStorage.removeItem(MINIMIZADO_KEY);
  }

  const introduccion = mostrarIntro && (
    <div className="modal-fondo" onMouseDown={cerrarIntro}>
      <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 480, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          <KaxMascota pose="celebrando" size={110} />
        </div>
        <h2 style={{ margin: "0 0 6px" }}>¡Conoce a Kax! 👋</h2>
        <p style={{ textAlign: "left" }}>
          Kax es tu asistente dentro de Kaxa — vive fijo del lado izquierdo del programa y vigila tu negocio
          solo, sin que tengas que ir a buscar nada. De vez en cuando te va a avisar cosas como:
        </p>
        <ul style={{ textAlign: "left", margin: "0 0 12px", paddingLeft: 20 }}>
          <li>Clientes con crédito pendiente desde hace mucho tiempo.</li>
          <li>Facturas de proveedores atrasadas.</li>
          <li>Productos con poco margen o que casi no dejan ganancia.</li>
          <li>Productos que venden bien pero se están quedando sin stock.</li>
          <li>Mercancía parada hace tiempo sin venderse.</li>
          <li>¡Y buenas noticias, como cuando vendes más que antes!</li>
        </ul>
        <p style={{ textAlign: "left" }}>
          Cambia de cara según lo que te está diciendo, y si le haces clic a un consejo te lleva directo a la
          pantalla para resolverlo. Si te estorba, puedes minimizarlo con la "×".
        </p>
        <button type="button" onClick={cerrarIntro} style={{ marginTop: 8 }}>
          ¡Entendido, vamos!
        </button>
      </div>
    </div>
  );

  if (minimizado) {
    return (
      <>
        <button type="button" className="kax-asistente-mini" onClick={expandir} title="Mostrar al Asistente Kax">
          <KaxMascota pose={poseDeConsejo(consejos[0])} size={40} />
        </button>
        {introduccion}
      </>
    );
  }

  const actual = consejos[indice];

  return (
    <>
      <div className="kax-asistente-lateral">
        <button type="button" className="kax-asistente-cerrar" onClick={minimizar} title="Minimizar">
          ×
        </button>
        <KaxMascota pose={poseDeConsejo(actual)} size={64} />
        {actual && (
          <div
            className={"kax-burbuja" + (actual.destino ? " kax-burbuja-clicable" : "")}
            onClick={actual.destino ? () => onNavegar(actual.destino!) : undefined}
            title={actual.destino ? "Ir a la pantalla relacionada" : undefined}
          >
            <span className="kax-burbuja-icono">{actual.icono}</span>
            <span>{actual.texto}</span>
          </div>
        )}
        {consejos.length > 1 && (
          <div className="kax-puntos">
            {consejos.map((_, i) => (
              <button
                key={i}
                type="button"
                className={i === indice ? "kax-punto-activo" : ""}
                onClick={() => setIndice(i)}
                title={`Consejo ${i + 1} de ${consejos.length}`}
              />
            ))}
          </div>
        )}
      </div>
      {introduccion}
    </>
  );
}
