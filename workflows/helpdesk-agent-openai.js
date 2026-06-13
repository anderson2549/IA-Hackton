#!/usr/bin/env node
import OpenAI from 'openai'

// ─── Config ──────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SENTRY_AUTH_TOKEN = process.env.SENTRY_AUTH_TOKEN
const SENTRY_ORG        = process.env.SENTRY_ORG        || 'tekton-as'
const SENTRY_PROJECT    = process.env.SENTRY_PROJECT    || 'php-laravel'
const SENTRY_REGION     = process.env.SENTRY_REGION     || 'https://us.sentry.io'
const JIRA_BASE_URL     = process.env.JIRA_BASE_URL
const JIRA_EMAIL        = process.env.JIRA_EMAIL
const JIRA_API_TOKEN    = process.env.JIRA_API_TOKEN
const BASE_PATH         = process.env.BASE_PATH         || '/workspace'

// ─── Model map (Claude → OpenAI) ─────────────────────────────────────────────
// haiku  → gpt-4o-mini  (rápido y barato)
// sonnet → gpt-4o       (más capaz)

const MODEL = { haiku: 'gpt-4o-mini', sonnet: 'gpt-4o' }

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { console.log(`[LOG] ${msg}`) }
function phase(name) { console.log(`\n${'─'.repeat(60)}\n  Phase: ${name}\n${'─'.repeat(60)}`) }

async function agent(prompt, { model = 'haiku', label = '' } = {}) {
  const oaiModel = MODEL[model] || model
  log(`agent:${label || oaiModel} → ${oaiModel}`)
  const res = await openai.chat.completions.create({
    model: oaiModel,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  })
  try {
    return JSON.parse(res.choices[0].message.content)
  } catch {
    return res.choices[0].message.content
  }
}

async function parallel(fns) {
  return Promise.all(fns.map(fn => fn().catch(err => { console.error(err.message); return null })))
}

// ─── Sentry REST API ─────────────────────────────────────────────────────────

async function fetchSentryIssues() {
  const url = `${SENTRY_REGION}/api/0/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/`
    + `?query=is:unresolved+level:error&limit=50`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}` },
  })
  if (!res.ok) throw new Error(`Sentry API error: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.map(i => ({
    id:          i.id,
    fingerprint: i.id,
    title:       i.title,
    message:     i.metadata?.value || i.title,
    culprit:     i.culprit,
    times_seen:  i.count,
    first_seen:  i.firstSeen,
    last_seen:   i.lastSeen,
    level:       i.level?.toUpperCase(),
  }))
}

// ─── JIRA REST API ───────────────────────────────────────────────────────────

const jiraAuth = () =>
  'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')

async function jiraRequest(path, method = 'GET', body) {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3${path}`, {
    method,
    headers: {
      Authorization: jiraAuth(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`JIRA ${method} ${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function findJiraProject() {
  const data = await jiraRequest('/project/search?maxResults=10')
  const preferred = data.values?.find(p =>
    /help.?desk|support|hd/i.test(p.name + p.key)
  )
  return preferred || data.values?.[0]
}

async function searchJiraIssues(jql) {
  const data = await jiraRequest(`/search?jql=${encodeURIComponent(jql)}&maxResults=5`)
  return data.issues || []
}

async function createJiraIssue({ projectKey, summary, description, priority, labels }) {
  const issue = await jiraRequest('/issue', 'POST', {
    fields: {
      project:   { key: projectKey },
      summary,
      issuetype: { name: 'Bug' },
      priority:  { name: priority || 'High' },
      labels:    labels || ['auto-detected', 'helpdesk-agent'],
      description: {
        type:    'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
      },
    },
  })
  return issue.key
}

async function addJiraComment(issueKey, text) {
  return jiraRequest(`/issue/${issueKey}/comment`, 'POST', {
    body: {
      type:    'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
  })
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ERROR_ANALYSIS_PROMPT = (err) => `
You are a senior backend engineer triaging a production error from a Laravel application.
Analyze this error and return a JSON object with exactly these fields:
- fingerprint (string): use "${err.fingerprint}"
- title (string): "[Sentry ${err.id}] <short actionable description>" max 80 chars
- severity (string): one of "critical","high","medium","low"
  critical = data loss/auth broken/DB down or seen 10+ times
  high     = core feature broken, seen 3-9 times
  medium   = partial degradation, seen 1-2 times
  low      = cosmetic/non-blocking
- description (string): markdown description for a JIRA ticket
- labels (array of strings)
- affected_service (string)

Error data:
${JSON.stringify(err, null, 2)}
`

const API_STATUS_PROMPT = (ep, statusCode, statusText) => `
You are a monitoring agent. An API health check was performed.
Return a JSON object with exactly these fields:
- name (string): "${ep.name}"
- healthy (boolean): ${statusCode >= 200 && statusCode < 300}
- status (string): "${statusCode} ${statusText}"
- critical (boolean): ${ep.critical}
- jira_needed (boolean): true only if critical=true AND NOT healthy
- title (string or null): if jira_needed, write "[API DOWN] ${ep.name} returning ${statusCode}"

Endpoint: ${JSON.stringify(ep)}
HTTP status received: ${statusCode} ${statusText}
`

const DEDUP_PROMPT = (item) => `
You are a JIRA deduplication agent. Given the existing JIRA issues below,
decide whether to create a new ticket or skip.

Return a JSON object with exactly these fields:
- exists (boolean): true if a matching open issue was found
- issue_key (string or null): existing JIRA key if exists=true
- action (string): one of "create", "update", "skip"
- reason (string): brief explanation

Candidate: ${JSON.stringify(item.data)}

Existing JIRA issues found:
${JSON.stringify(item.existingIssues, null, 2)}
`

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const priorityMap = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }

  // ── Phase 1: Ingest ─────────────────────────────────────────────────────────
  phase('Ingest')

  const [sentryIssues, endpointData] = await Promise.all([
    fetchSentryIssues().catch(err => {
      console.warn(`Sentry fetch failed (${err.message}), usando mock data`)
      return (await import(`${BASE_PATH}/mock-data/laravel-errors.json`, { assert: { type: 'json' } })).default
    }),
    import(`${BASE_PATH}/mock-data/api-endpoints.json`, { assert: { type: 'json' } })
      .then(m => m.default),
  ])

  const endpoints = endpointData
  const uniqueErrors = Object.values(
    sentryIssues.reduce((acc, e) => { acc[e.fingerprint] = acc[e.fingerprint] || e; return acc }, {})
  )

  log(`${uniqueErrors.length} errores únicos, ${endpoints.length} endpoints`)

  // ── Phase 2: Triage ─────────────────────────────────────────────────────────
  phase('Triage')

  // Verificar APIs en paralelo con fetch real
  const apiChecks = await parallel(endpoints.map(ep => async () => {
    let statusCode = 0, statusText = 'unreachable'
    try {
      const r = await fetch(ep.url, { signal: AbortSignal.timeout(5000) })
      statusCode = r.status
      statusText = r.statusText
    } catch {}
    return agent(API_STATUS_PROMPT(ep, statusCode, statusText), { label: `monitor:${ep.name}`, model: 'haiku' })
  }))

  const [analyzedErrors, apiStatuses] = await Promise.all([
    parallel(uniqueErrors.map(err => () =>
      agent(ERROR_ANALYSIS_PROMPT(err), { label: `analyze:${err.fingerprint}`, model: 'sonnet' })
    )),
    Promise.resolve(apiChecks),
  ])

  const validErrors = analyzedErrors.filter(Boolean)
  const validApis   = apiStatuses.filter(Boolean)
  log(`Triage: ${validErrors.length} errores, ${validApis.filter(a => !a.healthy).length} APIs caídas`)

  // ── Phase 3: Dedup ──────────────────────────────────────────────────────────
  phase('Dedup')

  const candidates = [
    ...validErrors.map(e  => ({ type: 'error', data: e })),
    ...validApis.filter(a => a.jira_needed).map(a => ({ type: 'api', data: a })),
  ]

  const dedupResults = await parallel(candidates.map(c => async () => {
    const jql = `project IS NOT EMPTY AND status != Done AND summary ~ "${(c.data.title || c.data.name).replace(/"/g, '\\"').slice(0, 50)}"`
    const existingIssues = await searchJiraIssues(jql).catch(() => [])
    const dedup = await agent(DEDUP_PROMPT({ ...c, existingIssues }), {
      label: `dedup:${c.data.fingerprint || c.data.name}`,
      model: 'haiku',
    })
    return { ...c, dedup }
  }))

  const toCreate = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'create')
  const toUpdate = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'update')
  const skipped  = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'skip')
  log(`Dedup: ${toCreate.length} crear, ${toUpdate.length} actualizar, ${skipped.length} omitir`)

  // ── Phase 4: Act ────────────────────────────────────────────────────────────
  phase('Act')

  const project = await findJiraProject().catch(() => null)
  if (!project) { console.warn('No se encontró proyecto JIRA, omitiendo creación de tickets'); }

  const created = await parallel([
    ...toCreate.map(item => async () => {
      if (!project) return null
      const key = await createJiraIssue({
        projectKey:  project.key,
        summary:     item.data.title || item.data.name,
        description: item.data.description || 'Incidente detectado por helpdesk-agent.',
        priority:    item.data.severity ? priorityMap[item.data.severity] : 'High',
        labels:      item.data.labels || ['auto-detected', 'helpdesk-agent'],
      })
      log(`Ticket creado: ${key}`)
      return key
    }),
    ...toUpdate.map(item => async () => {
      const key = item.dedup.issue_key
      await addJiraComment(key,
        `🔄 Recurrencia detectada por helpdesk-agent — ${new Date().toISOString()}\n` +
        `Error: ${item.data.fingerprint || item.data.name}`
      )
      log(`Comentario añadido a: ${key}`)
      return key
    }),
  ])

  // ── Summary ─────────────────────────────────────────────────────────────────
  const summary = {
    errors_processed: uniqueErrors.length,
    apis_checked:     endpoints.length,
    apis_unhealthy:   validApis.filter(a => !a.healthy).length,
    tickets_created:  toCreate.length,
    tickets_updated:  toUpdate.length,
    tickets_skipped:  skipped.length,
    results:          created.filter(Boolean),
  }

  console.log('\n=== RESULTADO ===')
  console.log(JSON.stringify(summary, null, 2))
  return summary
}

main().catch(err => { console.error(err); process.exit(1) })
