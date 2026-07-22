#!/bin/bash
# Doble clic en Mac: se actualiza solo, abre el navegador y arranca la app.
cd "$(dirname "$0")" || exit 1
npm run abrir
echo
echo "(La app se detuvo. Podes cerrar esta ventana.)"
