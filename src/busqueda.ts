// Busqueda insensible a acentos: "azucar" debe encontrar "Azúcar". SQLite no
// hace este tipo de normalizacion con LIKE por si solo, asi que el texto
// guardado se pasa por esta misma cadena de REPLACE en la consulta SQL, y el
// termino escrito por el usuario se normaliza igual en JS antes de bindearlo.
//
// El LOWER() nativo de SQLite solo baja de caja ASCII: "PAÑAL" queda igual
// (la Ñ mayuscula no cambia), por lo que hace falta un REPLACE aparte para
// cada vocal/eñe acentuada en mayuscula ademas de la version en minuscula.
export function sqlSinAcentos(columna: string): string {
  const pares: [string, string][] = [
    ["á", "a"], ["é", "e"], ["í", "i"], ["ó", "o"], ["ú", "u"], ["ñ", "n"],
    ["Á", "a"], ["É", "e"], ["Í", "i"], ["Ó", "o"], ["Ú", "u"], ["Ñ", "n"],
  ];
  let expr = `LOWER(${columna})`;
  for (const [acentuada, plana] of pares) {
    expr = `REPLACE(${expr},'${acentuada}','${plana}')`;
  }
  return expr;
}

// Rango Unicode de "Combining Diacritical Marks" (U+0300 a U+036F), armado
// con codigos numericos para evitar caracteres invisibles sueltos en el
// fuente: tras normalize("NFD") las tildes quedan como estos codepoints
// separados de su letra base.
const DIACRITICOS = new RegExp(`[\\u0300-\\u036f]`, "g");

export function normalizarTexto(texto: string): string {
  return texto.toLowerCase().normalize("NFD").replace(DIACRITICOS, "");
}
