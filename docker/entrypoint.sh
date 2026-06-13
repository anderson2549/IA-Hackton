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

# Descargar modelos necesarios (sin duplicados)
declare -A pulled
for MODEL_VAR in "$OLLAMA_MODEL" "$OLLAMA_MODEL_FAST" "$OLLAMA_MODEL_FULL"; do
    if [ -n "$MODEL_VAR" ] && [ -z "${pulled[$MODEL_VAR]}" ]; then
        echo "Descargando modelo: $MODEL_VAR"
        ollama pull "$MODEL_VAR"
        pulled[$MODEL_VAR]=1
    fi
done

# Ejecutar workflow directamente si se pasó la flag
if [ "${RUN_WORKFLOW:-false}" = "true" ]; then
    chmod +x /workspace/docker/run-workflow.sh
    exec /workspace/docker/run-workflow.sh
fi

# Ejecutar comando personalizado si se pasó
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

# Modo interactivo por defecto
echo ""
echo "=== Claude Code + Ollama listo ==="
echo "  Ollama API : http://localhost:11434"
echo "  Claude Code: ejecuta 'claude' en el terminal"
echo "  Workflow   : ejecuta '/workspace/docker/run-workflow.sh'"
echo ""
wait $OLLAMA_PID
