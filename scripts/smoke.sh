#!/bin/bash
# Smoke test: boots the API against each backend and exercises every endpoint.
# pg-boss on :4400, Absurd on :4401 — both against the same DATABASE_URL.
set -e
cd "$(dirname "$0")/.."

AUTH="${PANEL_USER:-admin}:${PANEL_PASSWORD:-admin}"
pass=0; fail=0
check() { # check <name> <expected-substring> <actual>
  if echo "$3" | grep -q "$2"; then echo "PASS  $1"; pass=$((pass+1));
  else echo "FAIL  $1 -> $3" | head -c 400; echo; fail=$((fail+1)); fi
}

json() { # json <json> <node-expr over parsed j>
  echo "$1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log($2)})"
}

# ============================================================
# Backend 1: pg-boss
# ============================================================
echo "=== pg-boss backend ==="
QUEUE_BACKEND=pgboss npx tsx src/api/server.ts > /tmp/api-pgboss.log 2>&1 &
PGBOSS_PID=$!
trap "kill $PGBOSS_PID $ABSURD_PID 2>/dev/null" EXIT
sleep 4

R=$(curl -s -u "$AUTH" localhost:4400/api/health)
check "health" '"backend":"pg-boss"' "$R"

R=$(curl -s -u "$AUTH" localhost:4400/api/queues)
check "queues list" '"agent-tasks"' "$R"
check "DLQ detection" '"isDeadLetter":true' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?queue=agent-tasks&state=failed&limit=1")
check "jobs filter by state" '"state":"failed"' "$R"

JOB_ID=$(json "$R" "j.jobs[0].id")
R=$(curl -s -u "$AUTH" "localhost:4400/api/queues/agent-tasks/jobs/$JOB_ID")
check "job detail has error output" 'LLM provider\|Transient\|seeded failure' "$R"

R=$(curl -s -u "$AUTH" -X POST "localhost:4400/api/queues/agent-tasks/jobs/$JOB_ID/retry")
check "retry failed job" '"ok":true' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/queues/agent-tasks/jobs/$JOB_ID")
check "job state flipped to retry" '"state":"retry"' "$R"

R=$(curl -s -u "$AUTH" -X POST "localhost:4400/api/queues/agent-tasks/jobs/$JOB_ID/retry")
check "retry non-retryable -> 409" 'not in a retryable state' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?queue=agent-tasks-dlq&limit=1")
check "DLQ job has source trace" '"sourceQueue":"agent-tasks"' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/queues/agent-tasks/stats?sinceMinutes=120")
check "queue stats endpoint" '"points"' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?state=nope")
check "invalid state -> 400" 'invalid query' "$R"

R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?state=sleeping")
check "sleeping filter is empty for pg-boss" '"total":0' "$R"

R=$(curl -s -u "$AUTH" localhost:4400/metrics)
check "prometheus metrics" 'pgqueue_jobs{backend="pg-boss",queue="agent-tasks",state="failed"}' "$R"

# --- auth ---
R=$(curl -s -o /dev/null -w "%{http_code}" localhost:4400/api/queues)
check "no credentials -> 401" "401" "$R"
R=$(curl -s -u "wrong:creds" -o /dev/null -w "%{http_code}" localhost:4400/api/queues)
check "bad credentials -> 401" "401" "$R"
R=$(curl -s -o /dev/null -w "%{http_code}" localhost:4400/metrics)
check "metrics open without credentials" "200" "$R"

# --- date filters ---
NOW=$(node -e "console.log(new Date().toISOString())")
LONG_AGO=$(node -e "console.log(new Date(Date.now()-30*86400e3).toISOString())")
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?limit=1&from=$LONG_AGO&to=$NOW")
check "date range filter returns jobs" '"total":[1-9]' "$R"
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?limit=1&from=$NOW")
check "future from returns none" '"total":0' "$R"
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?from=banana")
check "invalid from -> 400" 'invalid query' "$R"
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?from=$NOW&to=$LONG_AGO")
check "from after to -> 400" 'invalid query' "$R"

# --- id filter ---
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?id=${JOB_ID:0:8}&limit=5")
check "id prefix filter finds the job" "\"$JOB_ID\"" "$R"
R=$(curl -s -u "$AUTH" "localhost:4400/api/jobs?id=zz%25")
check "invalid id chars -> 400" 'invalid query' "$R"

# --- dashboard (Angular build in public/) ---
R=$(curl -s -u "$AUTH" localhost:4400/)
check "dashboard html served" "app-root" "$R"
MAIN_JS=$(echo "$R" | grep -o 'main-[A-Z0-9]*\.js' | head -1)
R=$(curl -s -u "$AUTH" -o /dev/null -w "%{http_code}" "localhost:4400/$MAIN_JS")
check "angular main bundle served" "200" "$R"
STYLES=$(curl -s -u "$AUTH" localhost:4400/ | grep -o 'styles-[A-Z0-9]*\.css' | head -1)
R=$(curl -s -u "$AUTH" -o /dev/null -w "%{http_code}" "localhost:4400/$STYLES")
check "angular styles served" "200" "$R"

# ============================================================
# Backend 2: Absurd (earendil-works/absurd)
# Requires: scripts/absurd.sql applied + demo/absurd-producer.ts run once.
# ============================================================
echo "=== absurd backend ==="
QUEUE_BACKEND=absurd PORT=4401 npx tsx src/api/server.ts > /tmp/api-absurd.log 2>&1 &
ABSURD_PID=$!
sleep 4

R=$(curl -s -u "$AUTH" localhost:4401/api/health)
check "health" '"backend":"absurd"' "$R"

R=$(curl -s -u "$AUTH" localhost:4401/api/queues)
check "queues list" '"agent-workflows"' "$R"
check "sleeping tasks counted" '"sleeping":[1-9]' "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?queue=agent-workflows&state=failed&limit=1")
check "jobs filter by state" '"state":"failed"' "$R"

JOB_ID=$(json "$R" "j.jobs[0].id")
R=$(curl -s -u "$AUTH" "localhost:4401/api/queues/agent-workflows/jobs/$JOB_ID")
check "job detail has failure output" 'LLM provider\|Transient' "$R"
check "job detail has checkpoints" '"checkpoints":\[{' "$R"
check "checkpoint is committed" '"status":"committed"' "$R"

R=$(curl -s -u "$AUTH" -X POST "localhost:4401/api/queues/agent-workflows/jobs/$JOB_ID/retry")
check "retry failed task" '"ok":true' "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/queues/agent-workflows/jobs/$JOB_ID")
check "task state flipped to retry" '"state":"retry"' "$R"

R=$(curl -s -u "$AUTH" -X POST "localhost:4401/api/queues/agent-workflows/jobs/$JOB_ID/retry")
check "retry non-retryable -> 409" 'not in a retryable state' "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?state=sleeping&limit=3")
check "sleeping filter finds suspended workflows" '"state":"sleeping"' "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?limit=25")
DISTINCT=$(json "$R" "new Set(j.jobs.map(x=>x.queue)).size")
check "cross-queue listing spans queues" '^[2-9]' "$DISTINCT"

R=$(curl -s -u "$AUTH" -o /dev/null -w "%{http_code}" "localhost:4401/api/jobs?queue=nope")
check "unknown queue -> 404" "404" "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/queues/agent-workflows/stats?sinceMinutes=120")
check "stats endpoint (no history in absurd -> empty)" '"points":\[\]' "$R"

R=$(curl -s -u "$AUTH" localhost:4401/metrics)
check "prometheus metrics" 'pgqueue_jobs{backend="absurd",queue="agent-workflows",state="sleeping"}' "$R"

R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?limit=1&from=$LONG_AGO&to=$NOW")
check "date range filter returns tasks" '"total":[1-9]' "$R"
R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?limit=1&from=$NOW")
check "future from returns none" '"total":0' "$R"

# Absurd ids are UUIDv7 (time-ordered): short prefixes are shared by many
# tasks, so exercise the filter with the full id.
R=$(curl -s -u "$AUTH" "localhost:4401/api/jobs?id=$JOB_ID&limit=5")
check "id filter finds the task" "\"$JOB_ID\"" "$R"
check "id filter matches exactly one" '"total":1' "$R"

echo "-----------------------------"
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
