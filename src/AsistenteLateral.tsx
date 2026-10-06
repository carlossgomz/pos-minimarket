import { useEffect, useRef, useState, CSSProperties } from "react";
import KaxMascota, { PoseKax } from "./KaxMascota";
import { Consejo, DestinoConsejo, obtenerConsejosGenerales } from "./asistente";
import { useSondeoVisible } from "./useSondeoVisible";

// Cada 5 minutos alcanza de sobra — son consejos, no algo que necesite
// sentirse en tiempo real, y así se evita sumarle presión al límite de
// consultas de Turso (ver memoria del proyecto sobre eso).
const REFRESCO_MS = 5 * 60 * 1000;
const MINIMIZADO_KEY = "kax-asistente-minimizado";
// Por PC (localStorage, no por usuario) — la mascota es nueva para
// cualquiera que abra Kaxa después de esta actualización, sea cajero o
// admin, así que se presenta una sola vez en cada equipo.
const INTRO_VISTA_KEY = "kax-intro-vista";

// A qué borde de la ventana quedó pegada la mascota (se puede arrastrar a
// cualquiera de los 4) y en qué punto de ese borde — 0 a 1, ej. 0.5 es el
// centro. Por PC, no por usuario, igual que MINIMIZADO_KEY.
type Borde = "izquierda" | "derecha" | "arriba" | "abajo";
const BORDE_KEY = "kax-asistente-borde";
const OFFSET_KEY = "kax-asistente-offset";
const MARGEN_BORDE = 14;
// No dejar que quede pegado justo en la esquina (0 o 1) — un poco adentro
// para que la burbuja/el botón de cerrar no se corten con el borde de la
// ventana.
const OFFSET_MIN = 0.08;
const OFFSET_MAX = 0.92;

function bordeGuardado(): Borde {
  const v = localStorage.getItem(BORDE_KEY);
  return v === "derecha" || v === "arriba" || v === "abajo" ? v : "izquierda";
}
function offsetGuardado(): number {
  const v = Number(localStorage.getItem(OFFSET_KEY));
  return v > 0 && v < 1 ? v : 0.5;
}

function poseDeConsejo(consejo: Consejo | undefined): PoseKax {
  if (!consejo) return "neutral";
  if (consejo.prioridad === "positivo") return "celebrando";
  if (consejo.prioridad === "urgente" || consejo.prioridad === "atencion") return "alerta";
  return "neutral";
}

// Mascota Kax — acompaña en cualquier pestaña, mostrando los mismos
// consejos accionables que ya existían en Estadísticas/Reportes pero sin
// tener que entrar ahí, con clic para ir directo a la pantalla que
// resuelve cada aviso (ej. "fulano debe hace muchos días" -> Cuentas). Se
// puede arrastrar (agarrando la mascota, no la burbuja ni los botones) a
// cualquiera de los 4 bordes de la ventana, donde el usuario se sienta
// más cómodo — la posición se recuerda por PC.
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

  const [borde, setBorde] = useState<Borde>(bordeGuardado);
  const [offsetFraccion, setOffsetFraccion] = useState<number>(offsetGuardado);
  // Mientras se arrastra, sigue el cursor libremente (sin pegarse a ningún
  // borde todavía) — recién al soltar se decide a cuál borde quedó más
  // cerca y se "pega" ahí.
  const [posicionLibre, setPosicionLibre] = useState<{ x: number; y: number } | null>(null);
  const arrastrandoRef = useRef(false);
  const inicioRef = useRef<{ x: number; y: number } | null>(null);

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

  useSondeoVisible(cargar, REFRESCO_MS, true);

  function minimizar() {
    setMinimizado(true);
    localStorage.setItem(MINIMIZADO_KEY, "1");
  }
  function expandir() {
    setMinimizado(false);
    localStorage.removeItem(MINIMIZADO_KEY);
  }

  // onMouseDown en la mascota (nunca en la burbuja/botones, que tienen su
  // propio onClick) — un umbral chico de movimiento distingue un clic
  // normal (para no romper nada si alguien solo quería tocarla) de un
  // arrastre de verdad.
  function alPresionarMascota(e: React.MouseEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    inicioRef.current = { x: e.clientX, y: e.clientY };
    arrastrandoRef.current = false;

    function mover(ev: MouseEvent) {
      const inicio = inicioRef.current;
      if (!inicio) return;
      const dx = ev.clientX - inicio.x;
      const dy = ev.clientY - inicio.y;
      if (!arrastrandoRef.current && Math.hypot(dx, dy) > 6) arrastrandoRef.current = true;
      if (arrastrandoRef.current) setPosicionLibre({ x: ev.clientX, y: ev.clientY });
    }

    function soltar(ev: MouseEvent) {
      document.removeEventListener("mousemove", mover);
      document.removeEventListener("mouseup", soltar);
      if (arrastrandoRef.current) {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const distancias: Record<Borde, number> = {
          izquierda: ev.clientX,
          derecha: w - ev.clientX,
          arriba: ev.clientY,
          abajo: h - ev.clientY,
        };
        const nuevoBorde = (Object.keys(distancias) as Borde[]).reduce((a, b) => (distancias[a] <= distancias[b] ? a : b));
        const nuevoOffset =
          nuevoBorde === "izquierda" || nuevoBorde === "derecha"
            ? Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, ev.clientY / h))
            : Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, ev.clientX / w));
        setBorde(nuevoBorde);
        setOffsetFraccion(nuevoOffset);
        localStorage.setItem(BORDE_KEY, nuevoBorde);
        localStorage.setItem(OFFSET_KEY, String(nuevoOffset));
      }
      arrastrandoRef.current = false;
      inicioRef.current = null;
      setPosicionLibre(null);
    }

    document.addEventListener("mousemove", mover);
    document.addEventListener("mouseup", soltar);
  }

  // Coordenadas fijas según el borde elegido — mismo cálculo para la
  // mascota expandida y para el iconito minimizado.
  function estiloDePosicion(): CSSProperties {
    if (posicionLibre) {
      return { position: "fixed", left: posicionLibre.x, top: posicionLibre.y, transform: "translate(-50%, -50%)", zIndex: 60 };
    }
    const pct = `${offsetFraccion * 100}%`;
    if (borde === "izquierda") return { position: "fixed", left: MARGEN_BORDE, top: pct, transform: "translateY(-50%)" };
    if (borde === "derecha") return { position: "fixed", right: MARGEN_BORDE, top: pct, transform: "translateY(-50%)" };
    if (borde === "arriba") return { position: "fixed", top: MARGEN_BORDE, left: pct, transform: "translateX(-50%)" };
    return { position: "fixed", bottom: MARGEN_BORDE, left: pct, transform: "translateX(-50%)" };
  }

  const introduccion = mostrarIntro && (
    <div className="modal-fondo" onMouseDown={cerrarIntro}>
      <div className="modal-caja" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: 480, textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
          <KaxMascota pose="celebrando" size={110} />
        </div>
        <h2 style={{ margin: "0 0 6px" }}>¡Conoce a Kax! 👋</h2>
        <p style={{ textAlign: "left" }}>
          Kax es tu asistente dentro de Kaxa — vigila tu negocio solo, sin que tengas que ir a buscar nada. De vez
          en cuando te va a avisar cosas como:
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
          pantalla para resolverlo. Puedes arrastrarlo (agarrando a Kax, no la burbuja) a cualquier borde de la
          pantalla donde te sea más cómodo, o minimizarlo con la "×".
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
        <button
          type="button"
          className="kax-asistente-mini"
          style={estiloDePosicion()}
          onMouseDown={alPresionarMascota}
          onClick={() => {
            // Un clic de verdad (sin arrastre) expande — alPresionarMascota
            // ya filtró el caso de arrastre real antes de que este onClick
            // llegue a dispararse.
            if (!arrastrandoRef.current) expandir();
          }}
          title="Mostrar al Asistente Kax (arrástralo para moverlo)"
        >
          <KaxMascota pose={poseDeConsejo(consejos[0])} size={40} />
        </button>
        {introduccion}
      </>
    );
  }

  const actual = consejos[indice];
  const filaInvertida = borde === "derecha";

  return (
    <>
      <div className="kax-asistente-lateral" style={{ ...estiloDePosicion(), flexDirection: filaInvertida ? "row-reverse" : "row" }}>
        <button type="button" className="kax-asistente-cerrar" onClick={minimizar} title="Minimizar">
          ×
        </button>
        <div className="kax-asistente-agarre" onMouseDown={alPresionarMascota} title="Arrastra para moverlo a otro borde">
          <KaxMascota pose={poseDeConsejo(actual)} size={64} />
        </div>
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
