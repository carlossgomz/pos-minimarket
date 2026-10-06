import { useEffect, useRef } from "react";

// Pausa un sondeo periódico mientras la ventana de Kaxa está minimizada o
// en segundo plano (document.visibilityState === "hidden") — esos avisos
// no necesitan actualizarse si nadie los está viendo, y cada sondeo activo
// en cada PC abierta le cuesta filas leídas a Turso. Al volver a estar
// visible, se recarga una sola vez de inmediato (no hay que esperar hasta
// el próximo tick del intervalo) para que el aviso quede al día enseguida.
//
// NO usar esto para sondeos que de verdad tienen que seguir igual aunque
// la ventana esté minimizada (pedidos de delivery + su alarma, la
// sincronización/outbox de offline.rs, estado_conexion) — esos siguen con
// su propio setInterval normal, sin pasar por acá.
export function useSondeoVisible(
  callback: () => void,
  intervaloMs: number,
  activo: boolean | null | undefined,
  llamarInmediato = true
) {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!activo) return;
    if (llamarInmediato) callbackRef.current();
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") callbackRef.current();
    }, intervaloMs);
    const alCambiarVisibilidad = () => {
      if (document.visibilityState === "visible") callbackRef.current();
    };
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activo, intervaloMs, llamarInmediato]);
}
