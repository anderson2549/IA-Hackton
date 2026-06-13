#!/bin/bash
set -e

# Iniciar Ollama en background
ollama serve &
OLLAMA_PID=$!

# Esperar a que Ollama esté listo
echo "Esperando que Ollama inicie..."
until curl -s http://localhost:11434/api/tags > /dev/null 2>&1; do
    sleep 1
done
echo "Ollama listo en http://localhost:11434"

# Descargar modelo por defecto si se especificó
if [ -n "$OLLAMA_MODEL" ]; then
    echo "Descargando modelo: $OLLAMA_MODEL"
    ollama pull "$OLLAMA_MODEL"
fi

# Ejecutar comando pasado al contenedor o mantener vivo
if [ "$#" -gt 0 ]; then
    exec "$@"
else
    echo ""
    echo "=== Claude Code + Ollama listo ==="
    echo "  Ollama API: http://localhost:11434"
    echo "  Claude Code: ejecuta 'claude' en el terminal"
    echo ""
    wait $OLLAMA_PID
fi
