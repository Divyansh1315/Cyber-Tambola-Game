// Shared handleSummary() so every scenario produces the same console report
// shape (matching the "Reporting" section of the request) plus a JSON file
// per run for later comparison. Import and re-export as `handleSummary` from
// each scenario file, e.g.:
//   export { textSummaryHandler as handleSummary } from '../lib/summary.js'
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js'

export function textSummaryHandler(data) {
  const m = data.metrics
  const get = (name, stat, fallback) => (m[name] && m[name].values && m[name].values[stat] !== undefined ? m[name].values[stat] : fallback)

  const totalRequests = get('http_reqs', 'count', 0)
  const failedRate = get('http_req_failed', 'rate', 0)
  const failedRequests = Math.round(totalRequests * failedRate)
  const successfulRequests = totalRequests - failedRequests

  const lines = []
  lines.push('')
  lines.push('================ Cyber Tambola Load Test — Summary ================')
  lines.push(`Total requests:        ${totalRequests}`)
  lines.push(`Successful requests:   ${successfulRequests}`)
  lines.push(`Failed requests:       ${failedRequests} (${(failedRate * 100).toFixed(2)}%)`)
  lines.push(`Avg response time:     ${get('http_req_duration', 'avg', 0).toFixed(1)} ms`)
  lines.push(`p95 response time:     ${get('http_req_duration', 'p(95)', 0).toFixed(1)} ms`)
  lines.push(`p99 response time:     ${get('http_req_duration', 'p(99)', 0).toFixed(1)} ms`)
  lines.push(`Max response time:     ${get('http_req_duration', 'max', 0).toFixed(1)} ms`)
  lines.push(`Requests/sec:          ${get('http_reqs', 'rate', 0).toFixed(2)}`)
  lines.push(`DB/API errors:         ${get('db_errors', 'count', 0)}`)
  lines.push(`Realtime connect fail: ${get('realtime_connect_failures', 'count', 0)}`)
  lines.push(`Duplicate prize wins:  ${get('duplicate_prize_winners', 'count', 0)}`)
  lines.push(`Sync failures:         ${get('sync_failures', 'count', 0)}`)
  lines.push(`Duplicate player sess: ${get('duplicate_player_sessions', 'count', 0)}`)
  lines.push(`Lost ticket markings:  ${get('lost_ticket_markings', 'count', 0)}`)
  lines.push(`Reconnect failures:    ${get('reconnect_failures', 'count', 0)}`)
  lines.push('=====================================================================')
  lines.push('')

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const result = {
    stdout: lines.join('\n') + textSummary(data, { indent: '  ', enableColors: false }),
  }
  result[`results/summary-${timestamp}.json`] = JSON.stringify(data, null, 2)
  return result
}
