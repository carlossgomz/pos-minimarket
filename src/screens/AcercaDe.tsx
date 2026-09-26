import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";

export default function AcercaDe() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion);
  }, []);

  return (
    <div style={{ padding: 20, maxWidth: 400 }}>
      <h3 style={{ margin: "0 0 14px" }}>Acerca de</h3>
      <p style={{ margin: 0, fontSize: 15 }}>
        Kaxa {version ? `v${version}` : "…"}
        <br />
        Edición: Día Express
      </p>
    </div>
  );
}
