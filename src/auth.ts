// Hash de contraseñas con SHA-256 vía Web Crypto, disponible nativamente en
// el webview (sin dependencias nuevas). Esto no es para blindar la app
// contra un atacante sofisticado — es de escritorio, para un solo local —
// pero evita guardar contraseñas en texto plano en la base de datos.
export async function hashPassword(password: string): Promise<string> {
  const datos = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", datos);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
