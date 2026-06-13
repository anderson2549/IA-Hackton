#!/bin/bash
set -e

# Inyectar variables en el settings.json de Claude
sed -i \
  -e "s|\${SENTRY_AUTH_TOKEN}|${SENTRY_AUTH_TOKEN}|g" \
  -e "s|\${JIRA_BASE_URL}|${JIRA_BASE_URL}|g" \
  -e "s|\${JIRA_EMAIL}|${JIRA_EMAIL}|g" \
  -e "s|\${JIRA_API_TOKEN}|${JIRA_API_TOKEN}|g" \
  /root/.claude/settings.json

echo "=== Ejecutando helpdesk-agent workflow ==="
echo "  Sentry org:     ${SENTRY_ORG:-tekton-as}"
echo "  Sentry project: ${SENTRY_PROJECT:-php-laravel}"
echo "  JIRA:           ${JIRA_BASE_URL}"
echo ""

claude run /workspace/workflows/helpdesk-agent.js \
  --dangerously-skip-permissions \
  --args "{
    \"sentryOrg\":     \"${SENTRY_ORG:-tekton-as}\",
    \"sentryProject\": \"${SENTRY_PROJECT:-php-laravel}\",
    \"sentryRegion\":  \"${SENTRY_REGION:-https://us.sentry.io}\",
    \"basePath\":      \"/workspace\"
  }"
