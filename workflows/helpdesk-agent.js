export const meta = {
  name: 'helpdesk-agent',
  description: 'Help Desk Support Agent: reads Laravel errors, monitors APIs, creates JIRA tickets',
  phases: [
    { title: 'Ingest',   detail: 'Load logs and API endpoints from source' },
    { title: 'Triage',   detail: 'Analyze errors and check API health in parallel' },
    { title: 'Dedup',    detail: 'Check existing JIRA tickets to avoid duplicates' },
    { title: 'Act',      detail: 'Create new JIRA tickets and post Slack notifications' },
  ],
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const ERROR_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    fingerprint:  { type: 'string', description: 'Unique key for this error class' },
    title:        { type: 'string', description: 'Short JIRA-ready title (max 80 chars)' },
    severity:     { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    description:  { type: 'string', description: 'Markdown description for the JIRA ticket body' },
    labels:       { type: 'array', items: { type: 'string' } },
    affected_service: { type: 'string' },
  },
  required: ['fingerprint', 'title', 'severity', 'description', 'labels', 'affected_service'],
}

const API_STATUS_SCHEMA = {
  type: 'object',
  properties: {
    name:     { type: 'string' },
    healthy:  { type: 'boolean' },
    status:   { type: 'string' },
    critical: { type: 'boolean' },
    jira_needed: { type: 'boolean' },
    title:    { type: 'string', description: 'JIRA title if ticket needed' },
  },
  required: ['name', 'healthy', 'status', 'critical', 'jira_needed'],
}

const DEDUP_SCHEMA = {
  type: 'object',
  properties: {
    exists:   { type: 'boolean' },
    issue_key: { type: 'string', description: 'Existing JIRA issue key if found, e.g. HD-42' },
    action:   { type: 'string', enum: ['create', 'update', 'skip'] },
    reason:   { type: 'string' },
  },
  required: ['exists', 'action', 'reason'],
}

// ─── Phase 1: Ingest ─────────────────────────────────────────────────────────

phase('Ingest')

const basePath = args?.basePath || 'C:/Users/ander/IA-Hackton'

const rawData = await agent(
  `Read these two local files and return their contents as JSON:
   1. ${basePath}/mock-data/laravel-errors.json
   2. ${basePath}/mock-data/api-endpoints.json
   Return: { errors: [...], endpoints: [...] }`,
  {
    label: 'load-data',
    model: 'haiku',
    schema: {
      type: 'object',
      properties: {
        errors:    { type: 'array' },
        endpoints: { type: 'array' },
      },
      required: ['errors', 'endpoints'],
    },
  }
)

const errors    = (rawData.errors    || []).filter(e => e.level === 'ERROR')
const endpoints = rawData.endpoints  || []

log(`Loaded ${errors.length} ERROR-level logs and ${endpoints.length} API endpoints`)

// Dedup errors by fingerprint — only analyze one per error class
const uniqueErrors = Object.values(
  errors.reduce((acc, e) => { acc[e.fingerprint] = acc[e.fingerprint] || e; return acc }, {})
)
log(`${uniqueErrors.length} unique error fingerprints after dedup (${errors.length - uniqueErrors.length} duplicates skipped)`)

// ─── Phase 2: Triage (parallel) ──────────────────────────────────────────────

phase('Triage')

const [analyzedErrors, apiStatuses] = await Promise.all([
  // Fan-out: analyze each unique error in parallel
  parallel(uniqueErrors.map(err => () =>
    agent(
      `You are a senior backend engineer triaging a production error from a Laravel application.
       Analyze this error and produce a JIRA-ready ticket analysis.

       Error details:
       ${JSON.stringify(err, null, 2)}

       Rules:
       - severity "critical" = data loss, auth broken, or DB down
       - severity "high"     = core feature broken for users
       - severity "medium"   = partial feature degraded
       - severity "low"      = cosmetic / non-blocking
       - fingerprint must match: ${err.fingerprint}
       - Title must be concise and actionable, max 80 chars`,
      { label: `analyze:${err.fingerprint}`, phase: 'Triage', model: 'sonnet', schema: ERROR_ANALYSIS_SCHEMA }
    )
  )),

  // Fan-out: check each API endpoint health in parallel
  parallel(endpoints.map(ep => () =>
    agent(
      `You are a monitoring agent checking API health for a production system.
       Check this API endpoint using the fetch tool and report its status.

       Endpoint: ${JSON.stringify(ep)}

       Use fetch to GET the URL. Determine:
       - healthy: true if HTTP 2xx, false otherwise
       - status: the HTTP status code and text
       - jira_needed: true if critical=true AND unhealthy
       - title: if jira_needed, write a short JIRA title like "[API DOWN] Payments API returning 503"`,
      { label: `monitor:${ep.name}`, phase: 'Triage', model: 'haiku', schema: API_STATUS_SCHEMA }
    )
  )),
])

const validErrors = analyzedErrors.filter(Boolean)
const validApis   = apiStatuses.filter(Boolean)

log(`Triage complete: ${validErrors.length} errors analyzed, ${validApis.filter(a => !a.healthy).length} APIs unhealthy`)

// ─── Phase 3: Dedup — check JIRA for existing tickets ────────────────────────

phase('Dedup')

// Build all items that might need a ticket
const candidates = [
  ...validErrors.map(e => ({ type: 'error', data: e, searchQuery: `"${e.fingerprint}" OR "${e.title}"` })),
  ...validApis.filter(a => a.jira_needed).map(a => ({ type: 'api', data: a, searchQuery: `"${a.name}" AND "API DOWN"` })),
]

log(`Checking JIRA dedup for ${candidates.length} candidates`)

const dedupResults = await parallel(candidates.map(c => () =>
  agent(
    `You are a JIRA deduplication agent.
     Search JIRA for existing open issues that match this error to avoid creating duplicates.

     Candidate: ${JSON.stringify(c.data)}
     Search hint: ${c.searchQuery}

     Use the searchJiraIssuesUsingJql tool to search for existing open issues.
     Search JQL: project IS NOT EMPTY AND status != Done AND (summary ~ "${c.data.title || c.data.name}" OR labels in ("${c.data.fingerprint || c.data.name}"))

     Decide:
     - action "create" if no matching open issue found
     - action "update" if an issue exists but needs a comment with new occurrence info
     - action "skip"   if a recent identical issue is already open and active
     Include issue_key if exists=true.`,
    { label: `dedup:${c.data.fingerprint || c.data.name}`, phase: 'Dedup', model: 'haiku', schema: DEDUP_SCHEMA }
  ).then(result => ({ ...c, dedup: result }))
))

const toCreate = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'create')
const toUpdate = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'update')
const skipped  = dedupResults.filter(Boolean).filter(r => r.dedup?.action === 'skip')

log(`Dedup result: ${toCreate.length} to create, ${toUpdate.length} to update, ${skipped.length} skipped`)

// ─── Phase 4: Act — create tickets + post updates ────────────────────────────

phase('Act')

const priorityMap = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' }

const created = await parallel([
  // Create new JIRA tickets
  ...toCreate.map(item => () =>
    agent(
      `Create a JIRA issue for this production incident using the createJiraIssue tool.

       Details:
       ${JSON.stringify(item.data, null, 2)}

       Instructions:
       - First call getVisibleJiraProjects to find the right project (prefer one named "Help Desk", "Support", or the first available)
       - Issue type: Bug
       - Priority: ${item.data.severity ? priorityMap[item.data.severity] || 'High' : 'High'}
       - Summary: ${item.data.title || item.data.name}
       - Description (markdown): ${item.data.description || 'Production incident detected by automated monitoring agent.'}
       - Labels: ${JSON.stringify(item.data.labels || ['auto-detected', 'helpdesk-agent'])}
       - Return the created issue key (e.g. HD-123)`,
      { label: `create-jira:${item.data.fingerprint || item.data.name}`, phase: 'Act', model: 'sonnet' }
    )
  ),

  // Add comments to existing tickets
  ...toUpdate.map(item => () =>
    agent(
      `Add a comment to existing JIRA issue ${item.dedup.issue_key} using addCommentToJiraIssue.

       Comment: "🔄 *Recurrence detected by helpdesk-agent* — ${new Date().toISOString()}
       Error class: ${item.data.fingerprint || item.data.name}
       This issue has been observed again in production. Please review and update status."`,
      { label: `update-jira:${item.dedup.issue_key}`, phase: 'Act', model: 'haiku' }
    )
  ),
])

// ─── Summary ─────────────────────────────────────────────────────────────────

const summary = {
  errors_processed:  uniqueErrors.length,
  apis_checked:      endpoints.length,
  apis_unhealthy:    validApis.filter(a => !a.healthy).length,
  tickets_created:   toCreate.length,
  tickets_updated:   toUpdate.length,
  tickets_skipped:   skipped.length,
  results:           created.filter(Boolean),
}

log(`✅ Run complete — ${summary.tickets_created} tickets created, ${summary.tickets_updated} updated, ${summary.tickets_skipped} skipped`)

return summary
