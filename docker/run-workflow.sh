#!/bin/bash
set -e

# Inyectar variables en el settings.json de Claude
sed -i \
  -e "s|\${SENTRY_AUTH_TOKEN}|${SENTRY_AUTH_TOKEN}|g" \
  -e "s|\${JIRA_BASE_URL}|${JIRA_BASE_URL}|g" \
  -e "s|\${JIRA_EMAIL}|${JIRA_EMAIL}|g" \
  -e "s|\${JIRA_API_TOKEN}|${JIRA_API_TOKEN}|g" \
  /root/.claude/settings.json

# Seleccionar variante según LLM_PROVIDER (openai | claude)
LLM_PROVIDER="${LLM_PROVIDER:-claude}"

echo "=== helpdesk-agent workflow ==="
echo "  Provider:       ${LLM_PROVIDER}"
echo "  Sentry org:     ${SENTRY_ORG:-tekton-as}"
echo "  JIRA:           ${JIRA_BASE_URL}"
echo ""

if [ "$LLM_PROVIDER" = "openai" ]; then
  echo "Usando OpenAI API..."
  node /workspace/workflows/helpdesk-agent-openai.js
else
  echo "Usando Claude Code (Anthropic)..."
  claude run /workspace/workflows/helpdesk-agent.js \
    --dangerously-skip-permissions \
    --args "{
      \"sentryOrg\":     \"${SENTRY_ORG:-tekton-as}\",
      \"sentryProject\": \"${SENTRY_PROJECT:-php-laravel}\",
      \"sentryRegion\":  \"${SENTRY_REGION:-https://us.sentry.io}\",
      \"basePath\":      \"/workspace\"
    }"
fi
